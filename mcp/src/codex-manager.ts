import { Codex, Thread } from "@openai/codex-sdk";

const CODEX_PATH = process.env.CODEX_BIN_PATH || "codex";
const DEFAULT_MODEL = process.env.CODEX_DEFAULT_MODEL || "gpt-5.4";
const DEFAULT_TIMEOUT_MS = 120_000;
const THREAD_TTL_MS = 30 * 60_000; // evict idle threads after 30 minutes

// Threads keyed by ID. Entries track last-use time and active turn count.
const threadPool = new Map<string, { thread: Thread; lastUsed: number; activeTurns: number }>();

// Per-thread mutex using object identity — immune to the thread.id timing race
// because the same Thread object is always returned from the pool.
// WeakMap auto-GCs when the Thread object is no longer referenced.
const threadLocks = new WeakMap<Thread, Promise<void>>();

let _codex: Codex | null = null;

function getCodex(): Codex {
  if (!_codex) {
    _codex = new Codex({ codexPathOverride: CODEX_PATH });
  }
  return _codex;
}

export function getDefaultTimeoutMs(): number {
  return DEFAULT_TIMEOUT_MS;
}

/** Evict threads that are idle (no active turns) and stale (past TTL). */
function evictStaleThreads(): void {
  const now = Date.now();
  for (const [id, entry] of threadPool) {
    if (entry.activeTurns === 0 && now - entry.lastUsed > THREAD_TTL_MS) {
      threadPool.delete(id);
    }
  }
}

/**
 * Start a new thread. Returns the Thread object plus the ID once it is available
 * (the ID is populated only after the first run() call).
 */
export function startThread(workingDirectory?: string, model?: string): Thread {
  evictStaleThreads();
  return getCodex().startThread({ workingDirectory, skipGitRepoCheck: true, model: model || DEFAULT_MODEL });
}

/**
 * Resume a thread by ID. Checks the local pool first to avoid re-creating.
 */
export function resumeThread(threadId: string, workingDirectory?: string, model?: string): Thread {
  evictStaleThreads();
  const entry = threadPool.get(threadId);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.thread;
  }
  const thread = getCodex().resumeThread(threadId, {
    workingDirectory,
    skipGitRepoCheck: true,
    model: model || DEFAULT_MODEL,
  });
  threadPool.set(threadId, { thread, lastUsed: Date.now(), activeTurns: 0 });
  return thread;
}

/**
 * Acquire a per-thread lock using object identity (WeakMap).
 * Returns a release function. Serializes concurrent turns on the same Thread.
 */
function acquireThreadLock(thread: Thread): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = threadLocks.get(thread) ?? Promise.resolve();
  threadLocks.set(thread, next);
  return prev.then(() => release);
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex call timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run a prompt on a thread with timeout. Returns the final response text.
 * Serializes concurrent calls on the same thread to prevent interleaved turns.
 *
 * NOTE: timeout_ms is per-call, not end-to-end. If this call is queued behind
 * another on the same thread, the wait for the mutex is not counted.
 */
export async function runOnThread(
  thread: Thread,
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const release = await acquireThreadLock(thread);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Track active turns so eviction doesn't remove threads mid-execution.
  // We increment before the call and always decrement in finally, re-reading
  // from the pool to handle threads that get registered mid-execution.
  const preEntry = thread.id ? threadPool.get(thread.id) : undefined;
  if (preEntry) preEntry.activeTurns++;

  try {
    const turn = await thread.run(prompt, { signal: controller.signal });
    // Register thread in pool now that ID is available
    if (thread.id && !threadPool.has(thread.id)) {
      threadPool.set(thread.id, { thread, lastUsed: Date.now(), activeTurns: 0 });
    } else if (thread.id) {
      threadPool.get(thread.id)!.lastUsed = Date.now();
    }
    return turn.finalResponse;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    // Decrement from current pool entry (may differ from preEntry for new threads)
    const postEntry = thread.id ? threadPool.get(thread.id) : undefined;
    if (preEntry) preEntry.activeTurns--;
    else if (postEntry) postEntry.activeTurns--;
    release();
  }
}

/** Get the thread ID after the first turn, throwing if it's still null. */
export function getThreadId(thread: Thread): string {
  const id = thread.id;
  if (!id) throw new Error("Thread ID not yet available — run at least one turn first");
  return id;
}

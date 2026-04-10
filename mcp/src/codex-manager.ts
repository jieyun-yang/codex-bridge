import { Codex, Thread, TurnOptions, ThreadOptions, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";

const CODEX_PATH = process.env.CODEX_BIN_PATH || "codex";
const DEFAULT_MODEL = process.env.CODEX_DEFAULT_MODEL || "gpt-5.4";
const DEFAULT_TIMEOUT_MS = 120_000;
const THREAD_TTL_MS = 30 * 60_000; // evict idle threads after 30 minutes

/** Runtime controls that callers can pass to startThread/resumeThread. */
export interface RuntimeOptions {
  model?: string;
  reasoning_effort?: ModelReasoningEffort;
  sandbox_mode?: SandboxMode;
}

export { ModelReasoningEffort, SandboxMode };

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

/** Build SDK ThreadOptions from our RuntimeOptions + working directory. */
function buildThreadOptions(workingDirectory?: string, runtime?: RuntimeOptions): ThreadOptions {
  return {
    workingDirectory,
    skipGitRepoCheck: true,
    model: runtime?.model || DEFAULT_MODEL,
    ...(runtime?.reasoning_effort && { modelReasoningEffort: runtime.reasoning_effort }),
    ...(runtime?.sandbox_mode && { sandboxMode: runtime.sandbox_mode }),
  };
}

/**
 * Start a new thread. Returns the Thread object plus the ID once it is available
 * (the ID is populated only after the first run() call).
 */
export function startThread(workingDirectory?: string, runtime?: RuntimeOptions): Thread {
  evictStaleThreads();
  return getCodex().startThread(buildThreadOptions(workingDirectory, runtime));
}

/**
 * Resume a thread by ID. Checks the local pool first to avoid re-creating.
 *
 * IMPORTANT: Runtime controls (model, reasoning_effort, sandbox_mode) are set
 * at thread creation time via SDK ThreadOptions. For hot-resumed threads
 * (already in the local pool), the runtime parameter is IGNORED because the
 * Thread object was already created with its original options. This is an SDK
 * constraint, not a bridge choice — there is no API to mutate ThreadOptions
 * after creation. Runtime controls only take effect on cold resumes (after
 * pool eviction or process restart).
 */
export function resumeThread(threadId: string, workingDirectory?: string, runtime?: RuntimeOptions): Thread {
  evictStaleThreads();
  const entry = threadPool.get(threadId);
  if (entry) {
    entry.lastUsed = Date.now();
    // Warn if caller passed runtime options that will be ignored on hot resume.
    if (runtime && (runtime.model || runtime.reasoning_effort || runtime.sandbox_mode)) {
      process.stderr.write(
        `[codex-bridge] Warning: runtime options ignored for hot-resumed thread ${threadId} — options are set at thread creation time only.\n`
      );
    }
    return entry.thread;
  }
  const thread = getCodex().resumeThread(threadId, buildThreadOptions(workingDirectory, runtime));
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
 *
 * `extraTurnOptions` is merged into the SDK's TurnOptions. Used by structured-
 * output flows (review, challenge) to attach `outputSchema`. The `signal`
 * field is always set by this function and cannot be overridden.
 */
export async function runOnThread(
  thread: Thread,
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  extraTurnOptions?: Omit<TurnOptions, "signal">
): Promise<string> {
  const release = await acquireThreadLock(thread);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Track active turns so eviction doesn't remove threads mid-execution.
  // Increment before the call, always decrement in finally.
  //
  // For brand-new threads (thread.id is null before first run), there is no
  // pool entry yet. After run() succeeds, we register with activeTurns: 1
  // (not 0) because we ARE inside an active turn. The finally decrement then
  // brings it back to 0. Previously this was set to 0, causing an underflow
  // to -1 that prevented eviction and could lead to mid-run thread deletion.
  const preEntry = thread.id ? threadPool.get(thread.id) : undefined;
  if (preEntry) preEntry.activeTurns++;

  try {
    const turn = await thread.run(prompt, {
      ...extraTurnOptions,
      signal: controller.signal,
    });
    // Register thread in pool now that ID is available.
    if (thread.id && !threadPool.has(thread.id)) {
      threadPool.set(thread.id, { thread, lastUsed: Date.now(), activeTurns: 1 });
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
    // Decrement from the current pool entry. For new threads, this is the
    // entry we just registered at activeTurns: 1 → goes to 0. For existing
    // threads, preEntry was incremented before run → goes back down.
    const currentEntry = thread.id ? threadPool.get(thread.id) : undefined;
    if (currentEntry) currentEntry.activeTurns--;
    release();
  }
}

/** Get the thread ID after the first turn, throwing if it's still null. */
export function getThreadId(thread: Thread): string {
  const id = thread.id;
  if (!id) throw new Error("Thread ID not yet available — run at least one turn first");
  return id;
}

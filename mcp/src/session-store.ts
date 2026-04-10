import { randomUUID } from "crypto";

/**
 * Bridge-local session store for staged context capsules.
 *
 * Why this exists: `codex_share_context` used to send a real Codex turn whose
 * only purpose was to extract a thread_id (the SDK only populates `thread.id`
 * after the first `run()`). That burned a billed turn per collaboration and
 * surfaced as "Context received." prose in transcripts.
 *
 * The new model: `share_context` stores a capsule under a bridge-generated
 * `session_id` (no Codex call). The next `codex_chat` resolves the session,
 * lazy-creates a real Codex thread, prepends the capsule to the first prompt,
 * marks the session consumed, and returns the now-real `thread_id`.
 *
 * Identity invariant
 * ------------------
 * Bridge `session_id` values are always prefixed with `ctx_` (see SESSION_PREFIX).
 * Real Codex `thread_id` values produced by the SDK do NOT use this prefix.
 * Both identity types share the same capsule store map; the prefix is the
 * sole guarantee that they cannot collide. `share-context.ts` enforces this
 * by rejecting any incoming `thread_id` that starts with `ctx_`.
 *
 * Lifetime: in-memory only. Capsules survive until consumed (or until the MCP
 * server process ends). There is no disk persistence in this slice — that
 * belongs in a future durability milestone, not here.
 */

export type MergeMode = "replace" | "append";

export interface CapsuleEntry {
  /** The aggregated context content to inject on the next chat call. */
  context: string;
  /** Monotonic version, incremented on every successful stage() against this key. */
  version: number;
  /** How the most recent stage() was applied. Diagnostic only. */
  mergeMode: MergeMode;
  /** Working directory recorded at stage time. Used as fallback if codex_chat
   *  is called without an explicit working_dir. */
  workingDir?: string;
  /** Wall-clock timestamp of the most recent stage() call. */
  updatedAt: number;
}

export const SESSION_PREFIX = "ctx_";

const store = new Map<string, CapsuleEntry>();

/**
 * Tracks session_ids that have been consumed by a successful chat turn.
 * Prevents the foot-gun where a caller reuses a session_id (which is supposed
 * to be one-shot) and silently gets a brand-new thread with no context.
 *
 * Only session_ids (ctx_*) are tracked here. Real thread_ids are not — they
 * may be reused indefinitely, which is the whole point of multi-turn threads.
 *
 * The set grows unbounded for the life of the MCP server process. Each entry
 * is small (~40 bytes) and the worst case is one entry per share_context call,
 * so this is acceptable for an in-process bridge with no long-running daemon.
 */
const consumedSessions = new Set<string>();

export function newSessionId(): string {
  return SESSION_PREFIX + randomUUID();
}

export function isSessionId(id: string): boolean {
  return id.startsWith(SESSION_PREFIX);
}

/** Has this session_id already been consumed by a successful chat turn? */
export function isConsumed(sessionId: string): boolean {
  return consumedSessions.has(sessionId);
}

/** Mark a session_id consumed so future reuse is rejected. */
export function markConsumed(sessionId: string): void {
  consumedSessions.add(sessionId);
}

/**
 * Stage a capsule. If `key` is omitted, a fresh session_id is generated.
 *
 * Merge semantics:
 * - "replace" (default): the new context wholly replaces any existing capsule.
 * - "append": the new context is concatenated to the existing capsule with a
 *   blank-line separator. If no prior capsule exists, append behaves like replace.
 */
export function stage(
  context: string,
  mergeMode: MergeMode = "replace",
  key?: string,
  workingDir?: string
): { key: string; entry: CapsuleEntry } {
  const id = key ?? newSessionId();
  const existing = store.get(id);

  let nextContext: string;
  if (mergeMode === "append" && existing) {
    nextContext = existing.context + "\n\n" + context;
  } else {
    nextContext = context;
  }

  const entry: CapsuleEntry = {
    context: nextContext,
    version: (existing?.version ?? 0) + 1,
    mergeMode,
    // workingDir is sticky across stages — once set, only an explicit new value
    // overrides it. This matches caller intent: stage with cwd once, reuse.
    workingDir: workingDir ?? existing?.workingDir,
    updatedAt: Date.now(),
  };
  store.set(id, entry);
  return { key: id, entry };
}

/** Read a capsule without removing it. */
export function peek(key: string): CapsuleEntry | undefined {
  return store.get(key);
}

/**
 * Atomically read and remove a capsule. Returns `undefined` if no capsule is
 * staged for this key.
 *
 * This is now used only in the `context_behavior: "consume"` path AFTER a
 * successful run. The chat tool uses peek-then-consume-on-success to avoid
 * destroying the capsule on a failed turn.
 */
export function consume(key: string): CapsuleEntry | undefined {
  const entry = store.get(key);
  if (entry) store.delete(key);
  return entry;
}

/** Drop a capsule without consuming it. */
export function reset(key: string): boolean {
  return store.delete(key);
}

/**
 * Per-stagingKey async mutex.
 *
 * Both `codex_share_context` and `codex_chat` operate on capsule entries
 * keyed by either a session_id or a thread_id. Without a shared lock,
 * `share_context` could stage a new capsule mid-run while `chat` had already
 * peeked an older version, and `chat`'s post-run `consume()` would then
 * delete the newer capsule — a lost write.
 *
 * Both tools acquire this lock around their critical section so that:
 * - share_context cannot land during a chat's peek→run→consume window
 * - chat vs chat on the same key is serialized (so the second caller sees
 *   the first call's consume / markConsumed before deciding what to do)
 * - share_context vs share_context is serialized (so the version counter
 *   is monotonic without races)
 *
 * Implementation: a Map of promise tails. Each acquirer awaits the current
 * tail and writes its own promise as the new tail. The release callback
 * resolves its promise and (if it's still the tail) removes the map entry
 * to prevent unbounded growth.
 */
const keyLocks = new Map<string, Promise<void>>();

export async function acquireKeyLock(key: string): Promise<() => void> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = () => {
      // Only delete if we're still the tail; otherwise a later acquirer is waiting.
      if (keyLocks.get(key) === next) {
        keyLocks.delete(key);
      }
      resolve();
    };
  });
  keyLocks.set(key, next);
  await prev;
  return release;
}

import { z } from "zod";
import { textResponse } from "../utils.js";
import { typedError } from "../errors.js";
import { stage, isSessionId, isConsumed, acquireKeyLock, newSessionId, SESSION_PREFIX } from "../session-store.js";

/**
 * codex_share_context — stage a context capsule for the next codex_chat call.
 *
 * This tool used to send a real Codex turn just to extract a thread_id (the
 * SDK only populates `thread.id` after the first `run()`). That billed-turn
 * indirection is gone: staging is now bridge-local. The next codex_chat call
 * lazy-creates the real Codex thread and injects the capsule on its first turn.
 *
 * Identity model:
 * - Returns a `session_id` (ctx_<uuid>) when no prior thread exists.
 * - Accepts an existing `session_id` to merge/replace a prior capsule.
 * - Accepts a real `thread_id` only with explicit `mode=replace`. `mode=append`
 *   on an existing thread is rejected because the thread already carries
 *   server-side context, and silent append risks duplicating the basis.
 * - Rejects any thread_id that starts with `ctx_` (would collide with the
 *   bridge-managed session_id namespace in the shared store).
 *
 * Note on thread_id staging: the bridge does NOT validate that the supplied
 * thread_id corresponds to a known/resumable Codex thread at stage time.
 * Validation happens lazily on the next codex_chat call. Because the chat
 * tool now uses peek-then-consume-on-success, a failed resume will not burn
 * the capsule — it remains staged for retry.
 *
 * Merge semantics: last-write-wins (`replace`) by default. `append` only when
 * the caller explicitly asks for accumulation on a session_id.
 *
 * working_dir: stored in the capsule and used as a fallback by codex_chat if
 * the chat call does not supply its own working_dir. Stage once, reuse later.
 */

export const shareContextSchema = z.object({
  context: z
    .string()
    .max(500_000)
    .describe("Background context to stage for the next codex_chat call (project summary, files, etc.)"),
  session_id: z
    .string()
    .optional()
    .describe("Existing session_id (ctx_<uuid>) to update. Omit to start a new staging session."),
  thread_id: z
    .string()
    .optional()
    .describe("Existing real thread_id. Requires mode=replace. mode=append on a thread_id is rejected to avoid duplicating server-side context."),
  mode: z
    .enum(["replace", "append"])
    .optional()
    .default("replace")
    .describe("How to merge with any prior staged capsule. Default replace (last-write-wins)."),
  working_dir: z
    .string()
    .optional()
    .describe("Working directory to record on the capsule. Used as fallback by codex_chat if it omits working_dir."),
});

export type ShareContextInput = z.infer<typeof shareContextSchema>;

export async function shareContextTool(input: ShareContextInput) {
  if (input.session_id && input.thread_id) {
    return typedError("identity_ambiguous", "codex_share_context", { session_id: input.session_id, thread_id: input.thread_id });
  }
  if (input.thread_id && input.mode === "append") {
    return typedError("stage_rejected", "codex_share_context", { thread_id: input.thread_id, mode: input.mode },
      "mode=append is not allowed with thread_id — resumed threads already carry server-side context."
    );
  }
  if (input.session_id && !isSessionId(input.session_id)) {
    return typedError("session_invalid", "codex_share_context", { session_id: input.session_id });
  }
  if (input.session_id && isConsumed(input.session_id)) {
    return typedError("session_consumed", "codex_share_context", { session_id: input.session_id });
  }
  if (input.thread_id && input.thread_id.startsWith(SESSION_PREFIX)) {
    return typedError("namespace_collision", "codex_share_context", { thread_id: input.thread_id });
  }

  // Resolve the staging key. For thread_id staging we store under thread_id;
  // for session_id (or new sessions) we store under session_id (which stage()
  // will generate if absent).
  //
  // Lock acquisition: we must hold the per-key lock around the stage() call
  // so that we cannot land a new capsule mid-flight while a concurrent
  // codex_chat is between its peek() and post-run consume(). Without this,
  // chat's consume() would delete the newer capsule we just staged (lost write).
  //
  // For brand-new sessions (no key supplied), we generate the session_id
  // first and then take the lock on it. This is safe because the freshly
  // generated UUID cannot collide with any in-flight operation.
  const stagingKey = input.thread_id ?? input.session_id ?? newSessionId();

  const releaseLock = await acquireKeyLock(stagingKey);
  try {
    // Re-check consumed-session inside the lock — a concurrent codex_chat
    // may have just consumed this session while we were waiting.
    if (input.session_id && isConsumed(input.session_id)) {
      return typedError("session_consumed", "codex_share_context", { session_id: input.session_id },
        `session_id ${input.session_id} was consumed by a concurrent codex_chat call.`
      );
    }

    const { key, entry } = stage(input.context, input.mode, stagingKey, input.working_dir);

    return textResponse(
      JSON.stringify(
        {
          session_id: input.thread_id ? null : key,
          thread_id: input.thread_id ?? null,
          state: "staged",
          context_version: entry.version,
          merge_mode: entry.mergeMode,
        },
        null,
        2
      )
    );
  } finally {
    releaseLock();
  }
}

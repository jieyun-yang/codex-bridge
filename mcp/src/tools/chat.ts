import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resumeThread, runOnThread, startThread, getThreadId, type RuntimeOptions } from "../codex-manager.js";
import { formatError, textResponse } from "../utils.js";
import { typedError, classifyError } from "../errors.js";
import { consume, peek, isSessionId, isConsumed, markConsumed, acquireKeyLock, SESSION_PREFIX } from "../session-store.js";
import { ChallengeResult, Focus } from "../schemas.js";
import { CHALLENGE_SYSTEM_PROMPT } from "../prompts.js";

/**
 * codex_chat — continue (or start) a Codex conversation.
 *
 * Three call shapes:
 * 1. session_id only: a capsule was staged via codex_share_context. We
 *    lazy-create a real Codex thread, prepend the capsule to the prompt for
 *    the first turn only, mark the session consumed on success, and return
 *    the new thread_id. The session_id is one-shot; reuse is rejected.
 * 2. thread_id only: existing behavior — resume the thread (active or
 *    historical) and run the prompt. If a capsule was staged against this
 *    thread_id (the share_context-with-thread_id path), it is consumed and
 *    prepended to this turn.
 * 3. neither / both: error. Caller must specify exactly one identity.
 *
 * context_behavior:
 * - "consume" (default): if a staged capsule exists for this session/thread,
 *   inject it into this turn and clear it on success.
 * - "ignore": skip the capsule for this turn but leave it staged.
 *
 * Concurrency: per-stagingKey async mutex serializes calls that share an
 * identity. Without this, two concurrent session_id chats would each call
 * startThread() and silently fork into different Codex threads. With it, the
 * second caller waits for the first to complete, then either succeeds on the
 * thread_id flow or rejects on the consumed-session_id check.
 *
 * Failure semantics: peek-then-consume-on-success. The capsule is removed
 * from the store ONLY after runOnThread() returns successfully. If the run
 * throws (timeout, abort, resume failure), the capsule remains staged and
 * the caller can retry without re-staging.
 */

export const chatSchema = z.object({
  prompt: z.string().describe("Message to send on the thread"),
  session_id: z
    .string()
    .optional()
    .describe("Bridge session_id (ctx_<uuid>) returned by codex_share_context. Use this for the first turn after staging context. One-shot — reuse is rejected."),
  thread_id: z
    .string()
    .optional()
    .describe("Real Codex thread_id, returned by a prior codex_chat or codex_exec call. Use this for follow-up turns or to resume a historical thread."),
  context_behavior: z
    .enum(["consume", "ignore"])
    .optional()
    .default("consume")
    .describe("Whether to inject any staged capsule on this turn. Default 'consume' (inject and clear on success)."),
  output_format: z
    .enum(["text", "challenge"])
    .optional()
    .default("text")
    .describe("Output format. 'text' (default) returns free-text response. 'challenge' constrains Codex to emit a structured ChallengeResult JSON validated against the bridge's schema — use for critique of design/spec/plan artifacts."),
  focus: Focus
    .optional()
    .default("balanced")
    .describe("Focus weighting for structured output modes (output_format=challenge). Default balanced. Ignored when output_format=text."),
  working_dir: z
    .string()
    .optional()
    .describe("Working directory for Codex. If omitted, falls back to working_dir recorded on a staged capsule."),
  model: z
    .string()
    .optional()
    .describe("Codex model override (e.g. 'gpt-5.4', 'codex-mini-latest'). Defaults to CODEX_DEFAULT_MODEL env var or gpt-5.4."),
  reasoning_effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Model reasoning effort. Higher = more thinking time, better quality, slower + more expensive."),
  sandbox_mode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional()
    .describe("Codex sandbox mode. Controls what the model can write. Default is SDK default (typically workspace-write)."),
  timeout_ms: z
    .number()
    .optional()
    .describe("Per-call timeout. If omitted, defaults to 120000 for text mode and 300000 for challenge mode (structured output constrains model generation and is measurably slower — the 120s default is too tight)."),
});

export type ChatInput = z.infer<typeof chatSchema>;

export async function chatTool(input: ChatInput) {
  // Validate identity arguments before acquiring any lock.
  if (input.session_id && input.thread_id) {
    return typedError("identity_ambiguous", "codex_chat", { session_id: input.session_id, thread_id: input.thread_id });
  }
  if (!input.session_id && !input.thread_id) {
    return typedError("identity_ambiguous", "codex_chat");
  }
  if (input.session_id && !isSessionId(input.session_id)) {
    return typedError("session_invalid", "codex_chat", { session_id: input.session_id });
  }
  if (input.thread_id && input.thread_id.startsWith(SESSION_PREFIX)) {
    return typedError("namespace_collision", "codex_chat", { thread_id: input.thread_id });
  }
  if (input.session_id && isConsumed(input.session_id)) {
    return typedError("session_consumed", "codex_chat", { session_id: input.session_id });
  }
  // Reject session_id + context_behavior=ignore. This combination is
  // semantically nonsensical: you staged context for a one-shot session
  // and then asked to skip it. Without this guard, the bridge would either
  // destroy the capsule (burning the session) or leave it orphaned.
  if (input.session_id && input.context_behavior === "ignore") {
    return typedError("stage_rejected", "codex_chat",
      { session_id: input.session_id, context_behavior: input.context_behavior },
      "context_behavior=ignore is not allowed with session_id. Sessions are one-shot — the staged context must be consumed on the first call. Use thread_id for follow-ups where ignore makes sense."
    );
  }

  // Resolve the staging key. For session_id flow we use the session_id; for
  // the thread_id-with-staged-capsule path we use the thread_id as the key
  // (matches share-context.ts which stores under thread_id when given one).
  const stagingKey = input.session_id ?? input.thread_id!;

  const releaseLock = await acquireKeyLock(stagingKey);

  try {
    // Re-check consumed-session after acquiring the lock — a concurrent caller
    // may have just consumed it while we were waiting. We can't surface the
    // winning thread_id here (it's not stored anywhere), so the recovery
    // advice is "use the thread_id you already received from that call, or
    // re-stage."
    if (input.session_id && isConsumed(input.session_id)) {
      return typedError("session_consumed", "codex_chat", { session_id: input.session_id },
        `session_id ${input.session_id} was consumed by a concurrent codex_chat call.`
      );
    }

    // Peek (do not consume yet). The capsule is removed only after the run
    // succeeds, so a failed turn leaves the capsule staged for retry.
    let capsuleText: string | undefined;
    let capsuleVersion: number | undefined;
    let capsuleWorkingDir: string | undefined;
    const entry = peek(stagingKey);

    // For session_id flow: the capsule MUST exist. If it doesn't (process
    // restart cleared in-memory state, typo, or capsule was reset), silently
    // proceeding would create a thread with no context — the caller would
    // believe their context was injected but it wasn't.
    if (input.session_id && !entry) {
      return typedError("session_invalid", "codex_chat",
        { session_id: input.session_id },
        `No staged capsule found for session_id ${input.session_id}. The in-memory store may have been cleared (process restart). Call codex_share_context again to re-stage.`
      );
    }

    if (entry) {
      capsuleVersion = entry.version;
      capsuleWorkingDir = entry.workingDir;
      if (input.context_behavior === "consume") {
        capsuleText = entry.context;
      }
    }

    // Build the actual prompt sent to Codex. Layers, in order:
    // 1. (challenge mode only) System instructions for structured critique.
    // 2. (challenge mode only) Explicit focus directive — bridge tells the
    //    model which `focus` value to emit in the result. Otherwise the model
    //    invents one and the schema becomes unstable by construction.
    // 3. Background context capsule, if one was peeked from the staging store.
    // 4. The user prompt itself.
    //
    // The system prompt is prepended on every challenge turn, not just the
    // first, because the SDK has no separate system-prompt channel. Token
    // overhead on multi-turn challenge threads is the cost of keeping the
    // structured-output framing sticky.
    const promptParts: string[] = [];
    if (input.output_format === "challenge") {
      promptParts.push(`[SYSTEM INSTRUCTION — follow this for the entire conversation]:\n${CHALLENGE_SYSTEM_PROMPT}`);
      promptParts.push(
        `[Focus directive]\nUse focus="${input.focus}" in the result. The bridge sets this value; do not change it.`
      );
    }
    if (capsuleText) {
      promptParts.push(`[Background context]\n${capsuleText}`);
    }
    promptParts.push(
      input.output_format === "challenge" || capsuleText
        ? `[Task]\n${input.prompt}`
        : input.prompt
    );
    const finalPrompt = promptParts.join("\n\n");

    // working_dir resolution: explicit input wins, then capsule's recorded
    // working_dir, then SDK default.
    const workingDir = input.working_dir ?? capsuleWorkingDir;

    // Build runtime options from caller params. These flow through to the
    // SDK's ThreadOptions via codex-manager.
    const runtime: RuntimeOptions = {
      ...(input.model && { model: input.model }),
      ...(input.reasoning_effort && { reasoning_effort: input.reasoning_effort }),
      ...(input.sandbox_mode && { sandbox_mode: input.sandbox_mode }),
    };

    // Get or create the underlying Thread. session_id flow always starts a
    // fresh thread (the session_id is a bridge concept, not a Codex one).
    // thread_id flow resumes the existing thread.
    const thread = input.session_id
      ? startThread(workingDir, runtime)
      : resumeThread(input.thread_id!, workingDir, runtime);

    // Attach outputSchema only when structured output is requested. For
    // text mode the run is unconstrained and finalResponse is free prose.
    const turnExtras = input.output_format === "challenge"
      ? { outputSchema: zodToJsonSchema(ChallengeResult, { target: "openAi" }) }
      : undefined;

    // Resolve the effective timeout. Challenge mode gets a longer budget
    // because outputSchema constrains model generation and is measurably
    // slower than free-text. Explicit caller values always win.
    const effectiveTimeout = input.timeout_ms ?? (input.output_format === "challenge" ? 300000 : 120000);

    const response = await runOnThread(thread, finalPrompt, effectiveTimeout, turnExtras);

    // For challenge mode: parse + validate BEFORE consuming the staged
    // capsule or marking the session consumed. If validation fails, the
    // caller can retry with the same staged context. Without this ordering,
    // a malformed Codex response permanently destroys the capsule.
    let structuredResult: ChallengeResult | null = null;
    if (input.output_format === "challenge") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch (err) {
        return typedError("schema_parse_error", "codex_chat", { raw_response: response },
          `Codex returned non-JSON for output_format=challenge: ${formatError(err)}`
        );
      }
      const validation = ChallengeResult.safeParse(parsed);
      if (!validation.success) {
        return typedError("schema_validation_error", "codex_chat",
          { issues: validation.error.issues, raw_response: response },
          `Codex output did not match ChallengeResult schema.`
        );
      }
      // Bridge overrides focus (model is told what to emit, but we're
      // authoritative even if it deviates) and normalizes strengths to []
      // when the model omits the field. Making strengths a hard requirement
      // in the schema would couple tool availability to a presentation field
      // — a review with valid findings shouldn't fail because strengths are
      // absent. The system prompt still instructs the model to populate it.
      structuredResult = {
        ...validation.data,
        focus: input.focus,
        strengths: validation.data.strengths ?? [],
      };
    }

    // Validation succeeded (or was skipped for text mode). NOW it's safe to
    // consume the capsule and mark the session.
    //
    // The `|| input.session_id` guard that was here previously handled the
    // ignore+session_id case (consume to prevent orphan). That combination
    // is now rejected at the top of the function, so we only consume when
    // capsule text was actually injected.
    if (capsuleText !== undefined) {
      consume(stagingKey);
    }
    if (input.session_id) {
      markConsumed(input.session_id);
    }

    // After the first run() the SDK populates thread.id. For session_id flow
    // this is the moment a real Codex thread_id materializes.
    const realThreadId = input.thread_id ?? getThreadId(thread);

    return textResponse(
      JSON.stringify(
        {
          // For text mode: response is free prose; result is null.
          // For challenge mode: response is the raw JSON string (still useful
          // for debugging) and result is the validated structured object.
          response: input.output_format === "challenge" ? null : response,
          result: structuredResult,
          structured: input.output_format === "challenge",
          thread_id: realThreadId,
          // session_id deliberately null in success response — it has been
          // consumed and cannot be reused. Caller must use thread_id for
          // follow-ups. This makes the foot-gun harder to hit.
          session_id: null,
          context_consumed: capsuleText !== undefined,
          context_version: capsuleVersion ?? null,
        },
        null,
        2
      )
    );
  } catch (err) {
    const msg = formatError(err);
    return typedError(classifyError(err), "codex_chat", {}, msg);
  } finally {
    releaseLock();
  }
}

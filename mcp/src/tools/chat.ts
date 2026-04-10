import { z } from "zod";
import { resumeThread, runOnThread, startThread, getThreadId, type RuntimeOptions } from "../codex-manager.js";
import { formatError, textResponse } from "../utils.js";
import { typedError, classifyError } from "../errors.js";
import { consume, peek, isSessionId, isConsumed, markConsumed, acquireKeyLock, SESSION_PREFIX } from "../session-store.js";
import { CHALLENGE_SYSTEM_PROMPT } from "../prompts.js";

/**
 * codex_chat — continue (or start) a Codex conversation.
 *
 * Identity model:
 * 1. session_id only: staged capsule is injected, real thread lazy-created.
 * 2. thread_id only: resume existing thread.
 * 3. neither / both: error.
 *
 * The system prompt for challenge mode is prepended to every turn so the
 * model knows the critique framing. Phase-specific templates are loaded
 * skill-side and passed through the prompt — the bridge is stateless about
 * phases.
 *
 * All output is free text. The skill handles rendering into the canonical
 * findings format. No outputSchema is attached — the system prompt tells
 * the model what content to produce, and Claude parses the result.
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
    .describe("Output format. 'text' (default) returns free-text response. 'challenge' prepends the challenge system prompt (structured critique framing) but still returns free text — no schema constraint is applied."),
  focus: z
    .enum(["balanced", "security", "architecture", "performance", "challenge"])
    .optional()
    .default("balanced")
    .describe("Focus weighting for challenge mode. Adds a focus directive to the prompt. Default balanced. Ignored when output_format=text."),
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
    .describe("Per-call timeout in ms. Defaults to 120000 (2 min). Bump for complex prompts."),
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
  if (input.session_id && input.context_behavior === "ignore") {
    return typedError("stage_rejected", "codex_chat",
      { session_id: input.session_id, context_behavior: input.context_behavior },
      "context_behavior=ignore is not allowed with session_id. Sessions are one-shot — the staged context must be consumed on the first call. Use thread_id for follow-ups where ignore makes sense."
    );
  }

  const stagingKey = input.session_id ?? input.thread_id!;
  const releaseLock = await acquireKeyLock(stagingKey);

  try {
    // Re-check consumed-session after acquiring the lock.
    if (input.session_id && isConsumed(input.session_id)) {
      return typedError("session_consumed", "codex_chat", { session_id: input.session_id },
        `session_id ${input.session_id} was consumed by a concurrent codex_chat call.`
      );
    }

    // Peek (do not consume yet — consume only after successful run).
    let capsuleText: string | undefined;
    let capsuleVersion: number | undefined;
    let capsuleWorkingDir: string | undefined;
    const entry = peek(stagingKey);

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

    // Build prompt. The challenge system prompt is only prepended on the
    // FIRST turn (session_id flow). Follow-ups (thread_id flow) already have
    // the framing from turn 1 in the SDK's thread history. This avoids
    // re-sending ~10 lines of system instructions on every follow-up turn.
    const promptParts: string[] = [];
    const isFirstTurn = !!input.session_id;
    if (input.output_format === "challenge" && isFirstTurn) {
      promptParts.push(`[SYSTEM INSTRUCTION]:\n${CHALLENGE_SYSTEM_PROMPT}`);
    }
    if (input.output_format === "challenge" && input.focus !== "balanced") {
      promptParts.push(`Focus: ${input.focus}.`);
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

    const workingDir = input.working_dir ?? capsuleWorkingDir;

    const runtime: RuntimeOptions = {
      ...(input.model && { model: input.model }),
      ...(input.reasoning_effort && { reasoning_effort: input.reasoning_effort }),
      ...(input.sandbox_mode && { sandbox_mode: input.sandbox_mode }),
    };

    const thread = input.session_id
      ? startThread(workingDir, runtime)
      : resumeThread(input.thread_id!, workingDir, runtime);

    const effectiveTimeout = input.timeout_ms ?? 120000;
    const response = await runOnThread(thread, finalPrompt, effectiveTimeout);

    // Run succeeded — consume capsule and mark session.
    if (capsuleText !== undefined) {
      consume(stagingKey);
    }
    if (input.session_id) {
      markConsumed(input.session_id);
    }

    const realThreadId = input.thread_id ?? getThreadId(thread);

    return textResponse(
      JSON.stringify(
        {
          response,
          thread_id: realThreadId,
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

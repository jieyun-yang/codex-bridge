/**
 * Typed error categories for the codex-bridge MCP.
 *
 * Every error response includes a structured envelope so the caller can
 * decide what to do next without parsing free-text error messages. The
 * envelope tells the caller: what failed, whether retry makes sense,
 * whether resume is possible, and what tool/action to try next.
 *
 * Usage in tools:
 *   return typedError("timeout", "codex_chat", { thread_id: "..." });
 */

export type ErrorCategory =
  | "codex_missing"         // codex binary not found
  | "auth_missing"          // no API key / auth not configured
  | "thread_not_found"      // thread ID unknown or not resumable
  | "thread_not_resumable"  // thread exists but can't resume (e.g., corrupt state)
  | "session_consumed"      // session_id already used (one-shot)
  | "session_invalid"       // session_id malformed or not a ctx_ prefix
  | "identity_ambiguous"    // both or neither session_id/thread_id provided
  | "namespace_collision"   // thread_id starts with ctx_ (reserved prefix)
  | "timeout"               // call exceeded timeout_ms
  | "cwd_invalid"           // working directory not accessible
  | "review_target_invalid" // missing base_branch or commit_sha for the target type
  | "diff_empty"            // nothing to review for the requested target
  | "diff_too_large"        // diff exceeds size limit
  | "schema_parse_error"    // structured output: JSON.parse failed
  | "schema_validation_error" // structured output: Zod validation failed
  | "stage_rejected"        // share_context: append on thread_id, or consumed session
  | "unknown"               // catch-all for unexpected errors

interface ErrorEnvelope {
  /** Which error category this is. */
  category: ErrorCategory;
  /** Human-readable message. */
  message: string;
  /** Which tool produced the error. */
  tool: string;
  /** Is the operation retryable with the same inputs? */
  retryable: boolean;
  /** Is the thread/session resumable after this error? */
  resumable: boolean;
  /** What to do next. Actionable guidance, not a vague suggestion. */
  next_step: string;
  /** Optional extra context (thread_id, session_id, raw output, etc.). */
  context?: Record<string, unknown>;
}

/**
 * Retry/resume semantics per category. Looked up by `typedError`.
 *
 * - retryable: true means calling the same tool with the same args might work.
 * - resumable: true means the thread/session is still usable after this error.
 */
const CATEGORY_SEMANTICS: Record<ErrorCategory, { retryable: boolean; resumable: boolean; next_step: string }> = {
  codex_missing:          { retryable: false, resumable: false, next_step: "Install the Codex CLI: npm install -g @openai/codex. Or set CODEX_BIN_PATH to the binary path." },
  auth_missing:           { retryable: false, resumable: false, next_step: "Set OPENAI_API_KEY or run: codex auth login." },
  thread_not_found:       { retryable: false, resumable: false, next_step: "Start a new session via codex_share_context, or check codex_list_sessions for historical threads." },
  thread_not_resumable:   { retryable: false, resumable: false, next_step: "Start a new session. The old thread state may be corrupt." },
  session_consumed:       { retryable: false, resumable: false, next_step: "Use the thread_id from the prior successful codex_chat response, or call codex_share_context to stage a new session." },
  session_invalid:        { retryable: false, resumable: false, next_step: "Pass a valid session_id (ctx_<uuid>) from codex_share_context, or use thread_id for follow-ups." },
  identity_ambiguous:     { retryable: false, resumable: true,  next_step: "Pass exactly one of session_id or thread_id, not both or neither." },
  namespace_collision:    { retryable: false, resumable: true,  next_step: "thread_id must not start with 'ctx_' — that prefix is reserved for session_ids. Pass it as session_id instead." },
  timeout:                { retryable: true,  resumable: true,  next_step: "Retry with a higher timeout_ms, or simplify the prompt to reduce model thinking time." },
  cwd_invalid:            { retryable: false, resumable: true,  next_step: "Check that the working_dir path exists and is readable." },
  review_target_invalid:  { retryable: false, resumable: false, next_step: "Provide the required parameter: base_branch for target=branch, commit_sha for target=commit." },
  diff_empty:             { retryable: false, resumable: false, next_step: "Nothing to review. Check the target — are there actually changes to review?" },
  diff_too_large:         { retryable: false, resumable: false, next_step: "Scope down: review individual commits, a single directory, or split the branch diff." },
  schema_parse_error:     { retryable: true,  resumable: true,  next_step: "Codex returned non-JSON for a structured mode. Retry — the model may produce valid JSON on the next attempt. Staged context is preserved." },
  schema_validation_error:{ retryable: true,  resumable: true,  next_step: "Codex returned JSON that didn't match the expected schema. Retry — or switch to output_format=text if the schema constraint is causing persistent failures. Staged context is preserved." },
  stage_rejected:         { retryable: false, resumable: true,  next_step: "Check the error detail. Common causes: mode=append on a thread_id (not allowed), or staging into a consumed session_id." },
  unknown:                { retryable: false, resumable: false, next_step: "Unexpected error. Check the message for details." },
};

/**
 * Classify a caught error into a typed category by pattern-matching on the
 * error name, message, and common SDK/CLI patterns. Used by tool catch blocks
 * to route to the right category instead of collapsing everything to "unknown".
 */
export function classifyError(err: unknown): ErrorCategory {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timeout";

    const msg = err.message.toLowerCase();

    // Thread-specific patterns FIRST — "thread xyz not found" must not match
    // the generic "not found" check below, which would misclassify as
    // codex_missing with harmful recovery guidance ("install Codex").
    if (msg.includes("thread") && (msg.includes("not found") || msg.includes("does not exist"))) {
      return "thread_not_found";
    }
    if (msg.includes("thread") && (msg.includes("corrupt") || msg.includes("not resumable"))) {
      return "thread_not_resumable";
    }
    // Auth failures — common patterns from OpenAI API.
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("api key") || msg.includes("authentication")) {
      return "auth_missing";
    }
    // Codex binary not found. Use specific patterns only — bare "not found"
    // was too broad and caught thread errors. Check ENOENT (Node fs/spawn
    // error code) and "command not found" (shell-level error).
    if (msg.includes("enoent") || msg.includes("command not found")) {
      return "codex_missing";
    }
    // Working directory issues.
    if (msg.includes("eacces") || msg.includes("enotdir") || msg.includes("permission denied")) {
      return "cwd_invalid";
    }
  }
  return "unknown";
}

/**
 * Build a typed error response for MCP. Returns the same shape as
 * `errorResponse()` from utils.ts (isError: true, content: [text]),
 * but the text is a JSON envelope that the skill can parse and act on.
 */
export function typedError(
  category: ErrorCategory,
  tool: string,
  context?: Record<string, unknown>,
  messageOverride?: string
) {
  const semantics = CATEGORY_SEMANTICS[category];
  const envelope: ErrorEnvelope = {
    category,
    message: messageOverride ?? `${tool} failed: ${category}`,
    tool,
    retryable: semantics.retryable,
    resumable: semantics.resumable,
    next_step: semantics.next_step,
    ...(context && { context }),
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
  };
}

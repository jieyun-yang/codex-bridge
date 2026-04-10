import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { startThread, runOnThread, getThreadId, type RuntimeOptions } from "../codex-manager.js";
import { formatError, textResponse } from "../utils.js";
import { typedError, classifyError } from "../errors.js";
import { ReviewResult, Focus } from "../schemas.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from "../prompts.js";

/**
 * codex_code_review — code review with structured output (M3).
 *
 * Architectural change vs Slice 1: this tool used to shell out to the
 * `codex review` CLI subcommand, which produced free-text. The new design
 * runs review through the SDK (`thread.run`) with `outputSchema` set, which
 * constrains the model to emit JSON conforming to the ReviewResult schema.
 * The bridge then parses + re-validates with Zod (the SDK does not validate
 * server-side — `finalResponse` is always a string).
 *
 * Diff sourcing: the bridge calls `git` directly. The previous CLI path used
 * codex's built-in review subcommand which had its own diff logic; we now
 * own that path so the rubric and system prompt can be tuned independently.
 *
 * Statelessness: review starts a fresh thread per call. There is no resume
 * path. Follow-ups (e.g. "focus on security") are a separate call with the
 * focus argument adjusted, not a thread continuation. This matches the
 * original SKILL.md design and avoids accumulating per-review thread state.
 */

const execFileAsync = promisify(execFile);

/**
 * Maximum diff size sent to Codex in one review call. Larger diffs are
 * rejected with a message asking the caller to scope down. The threshold is
 * conservative — chosen to leave headroom for the system prompt + rubric +
 * response in the model's context window. Reviews of larger changes should
 * be split by directory or commit.
 */
const MAX_DIFF_BYTES = 256 * 1024;

export const reviewSchema = z.object({
  target: z
    .enum(["uncommitted", "branch", "commit"])
    .optional()
    .default("uncommitted")
    .describe("What to review: uncommitted changes (default — git diff HEAD scope; untracked files are excluded, stage them with git add first), branch diff against a base, or a specific commit."),
  base_branch: z
    .string()
    .optional()
    .describe("Base branch for branch diff (e.g. 'main'). Required when target is 'branch'."),
  commit_sha: z
    .string()
    .optional()
    .describe("Commit SHA to review. Required when target is 'commit'."),
  focus: Focus
    .optional()
    .default("balanced")
    .describe("Optional focus weighting: balanced (default), security, architecture, performance, or challenge."),
  working_dir: z
    .string()
    .optional()
    .describe("Repository directory to review (must be a git repo)."),
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
    .describe("Codex sandbox mode. Reviews are typically read-only; default is SDK default."),
  timeout_ms: z
    .number()
    .optional()
    .default(300000)
    .describe("Per-call timeout. Code reviews with structured output can be slow — the model has to constrain its generation to the Zod-derived JSON schema AND reason about a diff. Default is 300s (5 min); bump it for very large or complex reviews."),
});

export type ReviewInput = z.infer<typeof reviewSchema>;

/** Reject ref strings that start with '-' to prevent git argument injection.
 *  This is NOT a full git ref validator — it only guards against the specific
 *  case where user input is parsed as a git flag by execFile. */
function rejectOptionLike(ref: string, name: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`${name} must not start with '-' (got '${ref}')`);
  }
}

/** Validate that a commit SHA looks like a hex hash (4-40 chars). */
function validateCommitSha(sha: string): void {
  rejectOptionLike(sha, "commit_sha");
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new Error(`commit_sha must be a hex SHA (4-40 chars), got '${sha}'`);
  }
}

/** Build the diff text for the requested target via shell git.
 *  User-supplied refs are validated via rejectOptionLike() / validateCommitSha()
 *  to prevent argument injection. execFile prevents shell metacharacter injection. */
async function buildDiff(input: ReviewInput): Promise<string> {
  const cwd = input.working_dir;

  if (input.target === "uncommitted") {
    // Working tree vs HEAD: includes both staged and unstaged changes.
    // No user-controlled refs here — HEAD is a literal.
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  if (input.target === "branch") {
    if (!input.base_branch) {
      throw new Error("base_branch is required when target is 'branch'");
    }
    rejectOptionLike(input.base_branch, "base_branch");
    // Three-dot diff: changes on HEAD since it diverged from base_branch.
    // validateRef() prevents flag injection (rejects refs starting with "-").
    // Do NOT use "--" before the revision range — git interprets everything
    // after "--" as file paths, not revisions, which silently returns empty.
    const { stdout } = await execFileAsync(
      "git",
      ["diff", `${input.base_branch}...HEAD`],
      { cwd, maxBuffer: 32 * 1024 * 1024 }
    );
    return stdout;
  }

  if (input.target === "commit") {
    if (!input.commit_sha) {
      throw new Error("commit_sha is required when target is 'commit'");
    }
    validateCommitSha(input.commit_sha);
    // Same as above: no "--" before the revision — git would treat it as a path.
    const { stdout } = await execFileAsync(
      "git",
      ["show", input.commit_sha],
      { cwd, maxBuffer: 32 * 1024 * 1024 }
    );
    return stdout;
  }

  throw new Error(`unknown target: ${input.target}`);
}

export async function reviewTool(input: ReviewInput) {
  try {
    // 1. Build the diff text. Validation errors here are user errors and are
    //    surfaced as errorResponse, not exceptions.
    let diff: string;
    try {
      diff = await buildDiff(input);
    } catch (err) {
      const msg = formatError(err);
      // Route to the right error category based on what git (or our validation) actually said.
      if (msg.includes("base_branch is required") || msg.includes("commit_sha is required")) {
        return typedError("review_target_invalid", "codex_code_review", { target: input.target }, msg);
      }
      const msgLower = msg.toLowerCase();
      if (msgLower.includes("not a git repository")) {
        return typedError("cwd_invalid", "codex_code_review", { working_dir: input.working_dir },
          `Not a git repository: ${input.working_dir ?? "cwd"}. codex_code_review requires a git repo.`
        );
      }
      if (msgLower.includes("unknown revision") || msgLower.includes("bad revision") || msgLower.includes("invalid object")) {
        return typedError("review_target_invalid", "codex_code_review",
          { target: input.target, base_branch: input.base_branch, commit_sha: input.commit_sha },
          `Git revision not found: ${msg}`
        );
      }
      if (msgLower.includes("enoent") || msgLower.includes("command not found")) {
        return typedError("codex_missing", "codex_code_review", {},
          "git binary not found. codex_code_review requires git to build diffs."
        );
      }
      return typedError("cwd_invalid", "codex_code_review", { working_dir: input.working_dir }, `Diff build failed: ${msg}`);
    }

    if (!diff || diff.trim().length === 0) {
      return typedError("diff_empty", "codex_code_review", { target: input.target });
    }

    if (diff.length > MAX_DIFF_BYTES) {
      return typedError("diff_too_large", "codex_code_review", { bytes: diff.length, limit: MAX_DIFF_BYTES });
    }

    // 2. Build the structured prompt: system instructions + rubric + framing
    //    + diff. The system prompt is prepended to the user prompt because
    //    the SDK has no separate system-prompt channel (same convention as
    //    codex_exec used in Slice 1).
    const userPrompt = buildReviewPrompt({
      target: {
        type: input.target,
        baseBranch: input.base_branch,
        commitSha: input.commit_sha,
      },
      focus: input.focus,
      diff,
    });
    const fullPrompt = `[SYSTEM INSTRUCTION — follow this for the entire conversation]:\n${REVIEW_SYSTEM_PROMPT}\n\n[TASK]:\n${userPrompt}`;

    // 3. Convert the Zod result schema to JSON schema for the SDK. target=openAi
    //    matches the format the Codex CLI's --output-schema expects.
    const jsonSchema = zodToJsonSchema(ReviewResult, { target: "openAi" });

    // 4. Start a fresh thread and run with outputSchema attached.
    const runtime: RuntimeOptions = {
      ...(input.model && { model: input.model }),
      ...(input.reasoning_effort && { reasoning_effort: input.reasoning_effort }),
      ...(input.sandbox_mode && { sandbox_mode: input.sandbox_mode }),
    };
    const thread = startThread(input.working_dir, runtime);
    const finalResponse = await runOnThread(
      thread,
      fullPrompt,
      input.timeout_ms,
      { outputSchema: jsonSchema }
    );

    // 5. Parse and validate.
    let parsed: unknown;
    try {
      parsed = JSON.parse(finalResponse);
    } catch (err) {
      return typedError("schema_parse_error", "codex_code_review", { raw_response: finalResponse },
        `Codex returned non-JSON: ${formatError(err)}`
      );
    }

    const validation = ReviewResult.safeParse(parsed);
    if (!validation.success) {
      return typedError("schema_validation_error", "codex_code_review",
        { issues: validation.error.issues, raw_response: finalResponse },
        "Codex output did not match ReviewResult schema."
      );
    }

    // 6. Override bridge-known metadata and normalize soft-optional fields.
    //    `focus` and `target` are authored by the bridge (model may deviate,
    //    we overwrite). `strengths` defaults to [] when the model omits it —
    //    the schema is optional to prevent a missing presentation field from
    //    sinking an otherwise-valid review (see prior Codex round-1 finding).
    //    The system prompt still instructs the model to populate strengths.
    const result: ReviewResult = {
      ...validation.data,
      focus: input.focus,
      target: {
        type: input.target,
        base_branch: input.base_branch,
        commit_sha: input.commit_sha,
      },
      strengths: validation.data.strengths ?? [],
    };

    // 7. Return the validated structured result alongside the thread_id (for
    //    optional follow-up via codex_chat) and a flag indicating the result
    //    is structured (so the skill knows to render it, not display raw).
    const threadId = getThreadId(thread);
    return textResponse(
      JSON.stringify(
        {
          result,
          thread_id: threadId,
          structured: true,
        },
        null,
        2
      )
    );
  } catch (err) {
    const msg = formatError(err);
    return typedError(classifyError(err), "codex_code_review", {}, msg);
  }
}

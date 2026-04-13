import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { startThread, runOnThread, getThreadId, getDefaultTimeoutMs, type RuntimeOptions } from "../codex-manager.js";
import { formatError, textResponse } from "../utils.js";
import { typedError, classifyError } from "../errors.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from "../prompts.js";

/**
 * codex_code_review — code review via SDK thread + system prompt.
 *
 * Builds a diff from git, sends it to a fresh Codex thread with the
 * review system prompt + rubric, and returns the free-text response.
 * The system prompt tells the model what to produce (findings, strengths,
 * pressure tests); Claude handles rendering on the skill side.
 *
 * Stateless: starts a fresh thread per call. Follow-ups (e.g. "focus on
 * security") are a separate call with the focus argument adjusted.
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
  focus: z
    .enum(["balanced", "security", "architecture", "performance", "challenge"])
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
    .optional()
    .describe("Per-call timeout in ms. Defaults to bridge DEFAULT_TIMEOUT_MS (currently 5 min). Lower for small diffs."),
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
        // Disambiguate: ENOENT from spawning git vs ENOENT from a bad cwd.
        const errPath = (err as NodeJS.ErrnoException).path ?? "";
        const isGitMissing = errPath === "git" || errPath.endsWith("/git") || msgLower.includes("command not found");
        if (!isGitMissing) {
          return typedError("cwd_invalid", "codex_code_review", { working_dir: input.working_dir },
            `Path not found (ENOENT): ${input.working_dir ?? "cwd"}. Check that the working directory exists.`
          );
        }
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

    // 2. Build the prompt: system instructions + rubric + framing
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

    // 3. Start a fresh thread and run. The system prompt tells the model
    //    what content to produce; Claude handles rendering on the skill side.
    const runtime: RuntimeOptions = {
      ...(input.model && { model: input.model }),
      ...(input.reasoning_effort && { reasoning_effort: input.reasoning_effort }),
      ...(input.sandbox_mode && { sandbox_mode: input.sandbox_mode }),
    };
    const thread = startThread(input.working_dir, runtime);
    const response = await runOnThread(thread, fullPrompt, input.timeout_ms ?? getDefaultTimeoutMs());

    const threadId = getThreadId(thread);
    return textResponse(
      JSON.stringify(
        {
          response,
          thread_id: threadId,
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

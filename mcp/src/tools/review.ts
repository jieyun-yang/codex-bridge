import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { errorResponse, formatError, textResponse } from "../utils.js";

const execFileAsync = promisify(execFile);
const CODEX_PATH = process.env.CODEX_BIN_PATH || "codex";
const DEFAULT_MODEL = process.env.CODEX_DEFAULT_MODEL || "gpt-5.4";

export const reviewSchema = z.object({
  target: z
    .enum(["uncommitted", "branch", "commit"])
    .optional()
    .default("uncommitted")
    .describe("What to review: uncommitted changes (default), branch diff against a base, or a specific commit"),
  base_branch: z.string().optional().describe("Base branch for branch diff (e.g. 'main'). Required when target is 'branch'."),
  commit_sha: z.string().optional().describe("Commit SHA to review. Required when target is 'commit'."),
  model: z.string().optional().describe("Model override (e.g. 'gpt-5.4')"),
  working_dir: z.string().optional().describe("Repository directory to review"),
  timeout_ms: z.number().optional().default(120000),
});

export type ReviewInput = z.infer<typeof reviewSchema>;

export async function reviewTool(input: ReviewInput) {
  try {
    const args = ["review"];
    args.push("-c", `model=${JSON.stringify(input.model || DEFAULT_MODEL)}`);

    if (input.target === "branch") {
      if (!input.base_branch) {
        return errorResponse("codex_review failed: base_branch is required when target is 'branch'");
      }
      args.push("--base", input.base_branch);
    } else if (input.target === "commit") {
      if (!input.commit_sha) {
        return errorResponse("codex_review failed: commit_sha is required when target is 'commit'");
      }
      args.push("--commit", input.commit_sha);
    }

    const { stdout, stderr } = await execFileAsync(CODEX_PATH, args, {
      cwd: input.working_dir,
      timeout: input.timeout_ms,
    });

    const review = stdout || stderr || "(no output)";
    return textResponse(review);
  } catch (err) {
    return errorResponse(`codex_review failed: ${formatError(err)}`);
  }
}

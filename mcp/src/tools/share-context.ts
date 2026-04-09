import { z } from "zod";
import { startThread, resumeThread, runOnThread, getThreadId } from "../codex-manager.js";
import { errorResponse, formatError, textResponse } from "../utils.js";

export const shareContextSchema = z.object({
  context: z.string().describe("Background context to push to Codex (project summary, files, etc.)"),
  thread_id: z.string().optional().describe("Existing thread ID. If omitted, creates a new thread."),
  working_dir: z.string().optional(),
  timeout_ms: z.number().optional().default(120000),
});

export type ShareContextInput = z.infer<typeof shareContextSchema>;

export async function shareContextTool(input: ShareContextInput) {
  try {
    const thread = input.thread_id
      ? resumeThread(input.thread_id, input.working_dir)
      : startThread(input.working_dir);

    await runOnThread(
      thread,
      `[Context only — acknowledge with "Context received." and wait for further instructions]\n\n${input.context}`,
      input.timeout_ms
    );

    const threadId = input.thread_id ?? getThreadId(thread);
    return textResponse(JSON.stringify({ threadId, status: "context_shared" }, null, 2));
  } catch (err) {
    return errorResponse(`codex_share_context failed: ${formatError(err)}`);
  }
}

import { z } from "zod";
import { resumeThread, runOnThread } from "../codex-manager.js";
import { errorResponse, formatError, textResponse } from "../utils.js";

export const chatSchema = z.object({
  thread_id: z.string().describe("Thread ID returned by codex_exec, or any historical thread ID"),
  prompt: z.string().describe("Follow-up message to send on the existing thread"),
  working_dir: z.string().optional(),
  timeout_ms: z.number().optional().default(120000),
});

export type ChatInput = z.infer<typeof chatSchema>;

export async function chatTool(input: ChatInput) {
  try {
    const thread = resumeThread(input.thread_id, input.working_dir);
    const response = await runOnThread(thread, input.prompt, input.timeout_ms);
    return textResponse(JSON.stringify({ response, threadId: input.thread_id }, null, 2));
  } catch (err) {
    return errorResponse(`codex_chat failed: ${formatError(err)}`);
  }
}

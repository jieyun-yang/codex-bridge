import { z } from "zod";
import { startThread, runOnThread, getThreadId } from "../codex-manager.js";
import { errorResponse, formatError, textResponse } from "../utils.js";

export const execSchema = z.object({
  prompt: z.string().describe("The task or question to send to Codex"),
  system_prompt: z
    .string()
    .optional()
    .describe("System-level role/persona prompt (e.g. 'You are a skeptical architect...')"),
  working_dir: z.string().optional().describe("Working directory for Codex to operate in"),
  model: z.string().optional().describe("Model override (e.g. 'codex-mini-latest')"),
  timeout_ms: z.number().optional().default(120000),
});

export type ExecInput = z.infer<typeof execSchema>;

export async function execTool(input: ExecInput) {
  try {
    const thread = startThread(input.working_dir, input.model);

    // The Codex SDK has no real system prompt channel. When provided,
    // system_prompt is prepended to the user prompt as a single turn.
    // This avoids paying cold-start cost twice (the old two-turn design
    // split the timeout budget and often timed out on the system turn).
    const prompt = input.system_prompt
      ? `[SYSTEM INSTRUCTION — follow this for the entire conversation]:\n${input.system_prompt}\n\n[TASK]:\n${input.prompt}`
      : input.prompt;

    const response = await runOnThread(thread, prompt, input.timeout_ms);
    const threadId = getThreadId(thread);

    return textResponse(JSON.stringify({ response, threadId }, null, 2));
  } catch (err) {
    return errorResponse(`codex_exec failed: ${formatError(err)}`);
  }
}

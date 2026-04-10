import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { formatError, textResponse } from "../utils.js";
import { typedError } from "../errors.js";

export const listSessionsSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(10),
});

export type ListSessionsInput = z.infer<typeof listSessionsSchema>;

export async function listSessionsTool(input: ListSessionsInput) {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  try {
    const raw = await readFile(indexPath, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-input.limit)
      .reverse();

    const sessions = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    return textResponse(JSON.stringify({ sessions, count: sessions.length }, null, 2));
  } catch (err) {
    return typedError("unknown", "codex_list_sessions", { path: indexPath }, formatError(err));
  }
}

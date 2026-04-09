import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { execSchema, execTool } from "./tools/exec.js";
import { chatSchema, chatTool } from "./tools/chat.js";
import { shareContextSchema, shareContextTool } from "./tools/share-context.js";
import { reviewSchema, reviewTool } from "./tools/review.js";
import { listSessionsSchema, listSessionsTool } from "./tools/sessions.js";

const server = new McpServer({
  name: "codex-bridge",
  version: "2.0.0",
});

// One-shot task delegation
server.tool(
  "codex_exec",
  "Send a one-shot task or question to Codex and get a response with a threadId for follow-up",
  execSchema.shape,
  execTool
);

// Multi-turn follow-up on an existing thread (handles both active and historical threads)
server.tool(
  "codex_chat",
  "Continue a conversation on an existing Codex thread. Works with both active in-memory threads and historical thread IDs (auto-resumes via SDK).",
  chatSchema.shape,
  chatTool
);

// Push context without triggering action
server.tool(
  "codex_share_context",
  "Push context to a Codex thread without asking it to act. Returns threadId for follow-up calls.",
  shareContextSchema.shape,
  shareContextTool
);

// Code review via CLI subprocess
server.tool(
  "codex_review",
  "Run Codex code review on uncommitted changes, a branch diff, or a specific commit",
  reviewSchema.shape,
  reviewTool
);

// List previous sessions
server.tool(
  "codex_list_sessions",
  "List recent Codex sessions from ~/.codex/session_index.jsonl",
  listSessionsSchema.shape,
  listSessionsTool
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("codex-bridge MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});

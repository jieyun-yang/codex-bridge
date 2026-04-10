import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { chatSchema, chatTool } from "./tools/chat.js";
import { shareContextSchema, shareContextTool } from "./tools/share-context.js";
import { reviewSchema, reviewTool } from "./tools/code-review.js";
import { listSessionsSchema, listSessionsTool } from "./tools/sessions.js";

const server = new McpServer({
  name: "codex-bridge",
  version: "3.2.0",
});

// Multi-turn chat. Accepts either a session_id (from codex_share_context) for
// the first turn after staging context, or a real thread_id for follow-ups
// and historical resumes. Lazy-creates the underlying Codex thread when given
// a session_id, so no billed turn is wasted on context staging.
//
// output_format=challenge prepends the challenge system prompt for structured
// critique framing. All output is free text — Claude handles rendering.
server.tool(
  "codex_chat",
  "Send a message on a Codex thread. Pass session_id (from codex_share_context) for the first turn after staging context, or thread_id for follow-ups / historical resumes. Exactly one of session_id or thread_id is required. Use output_format=challenge for structured critique of design/spec/plan artifacts.",
  chatSchema.shape,
  chatTool
);

// Stage context for the next codex_chat call. No Codex turn is consumed —
// the capsule is held bridge-side and injected on the next chat call.
server.tool(
  "codex_share_context",
  "Stage a context capsule for the next codex_chat call. Bridge-local — does not consume a Codex turn. Returns a session_id (ctx_<uuid>) to pass to codex_chat.",
  shareContextSchema.shape,
  shareContextTool
);

// Code review. Explicitly for CODE — diffs, files, generated code.
// For plans, specs, designs, or other non-code artifacts, use codex_chat
// with output_format=challenge instead.
server.tool(
  "codex_code_review",
  "Run Codex code review on uncommitted changes, a branch diff, or a specific commit. For plans/specs/designs/any non-code artifact, use codex_chat with output_format=challenge instead.",
  reviewSchema.shape,
  reviewTool
);

// Debug/recovery only: list recent Codex sessions on disk for manual thread
// resurrection after local state loss. Not part of normal collaboration flow.
server.tool(
  "codex_list_sessions",
  "DEBUG/RECOVERY: list recent Codex sessions from ~/.codex/session_index.jsonl. Used for manual thread resurrection after local state loss; not part of normal collaboration flow.",
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

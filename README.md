# codex-bridge

A two-piece toolkit for **Claude ↔ Codex collaboration** in Claude Code:

1. **`mcp/`** — A stdio MCP server (`codex-bridge`) that wraps the [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) Thread API. Gives Claude four tools: `codex_chat`, `codex_share_context`, `codex_code_review`, `codex_list_sessions`. Threads are pooled in-process with a 30-minute TTL and a per-thread mutex so multi-round conversations preserve context.
2. **`skill/codex-collab/`** — A Claude Code skill (`/codex-collab`) with three modes: **challenge** (critique any artifact with optional phase-specific lenses), **code-review** (review uncommitted/branch/commit diffs), **delegate** (hand off a scoped task). The skill is the human-facing front door; the MCP is the engine.

The two pieces are independent — you can install just the MCP and call its tools directly, or install both for the slash-command UX.

---

## What's in the box

```
codex-bridge/
├── mcp/                          # the stdio MCP server (v3.2.0)
│   ├── src/
│   │   ├── index.ts              # registers the 4 tools
│   │   ├── codex-manager.ts      # thread pool, mutex, TTL eviction, RuntimeOptions
│   │   ├── session-store.ts      # bridge-local capsule staging (session_id → thread_id)
│   │   ├── schemas.ts            # Zod result schemas (ReviewResult, ChallengeResult)
│   │   ├── prompts.ts            # bridge-side system prompts + code-review rubric
│   │   ├── errors.ts             # typed error categories + classifyError
│   │   ├── utils.ts              # formatError, textResponse helpers
│   │   └── tools/
│   │       ├── chat.ts           # multi-turn chat + structured challenge output
│   │       ├── share-context.ts  # stage context capsule (bridge-local, no Codex turn)
│   │       ├── code-review.ts    # structured code review via git diff + outputSchema
│   │       └── sessions.ts       # list ~/.codex/session_index.jsonl (debug/recovery)
│   ├── test/                     # 34 contract tests (vitest)
│   ├── package.json
│   └── tsconfig.json
└── skill/
    └── codex-collab/             # the Claude Code skill (/codex-collab)
        ├── SKILL.md
        └── templates/            # phase-specific challenge lenses (shape, design, architecture, security, code)
```

The MCP exposes **four tools**:

| Tool | Purpose |
|---|---|
| `codex_chat` | Send a message on a Codex thread. Pass `session_id` (from `codex_share_context`) for the first turn, or `thread_id` for follow-ups. Supports `output_format=challenge` for structured critique with typed `ChallengeResult`. Runtime controls: `model`, `reasoning_effort`, `sandbox_mode`. |
| `codex_share_context` | Stage a context capsule for the next `codex_chat` call. **Bridge-local — does not consume a Codex turn.** Returns a `session_id` to pass to `codex_chat`. |
| `codex_code_review` | Structured code review on uncommitted changes, a branch diff, or a specific commit. Returns a typed `ReviewResult` with `findings[]`, `pressure_test[]`, and `strengths[]`. Requires a git repo. |
| `codex_list_sessions` | Debug/recovery: list recent Codex sessions from `~/.codex/session_index.jsonl`. |

### Key architectural features

- **No wasted Codex turns.** `codex_share_context` stages context locally. The real Codex thread is lazy-created on the first `codex_chat` call, so context staging never bills a turn.
- **Structured output.** `codex_chat` (challenge mode) and `codex_code_review` use the SDK's `outputSchema` to constrain Codex to typed JSON, validated bridge-side with Zod. The `nullish()` helper handles the OpenAI convention where optional = required + nullable.
- **Typed errors.** Every error returns a JSON envelope with `category`, `retryable`, `resumable`, and `next_step`. 17 error categories from `codex_missing` to `schema_validation_error`.
- **Consume-on-success.** Staged capsules are only consumed after a successful run + validation. Failed turns (timeout, schema mismatch) leave the capsule staged for retry.
- **Per-key async mutex.** Both `codex_share_context` and `codex_chat` share a lock to prevent lost writes from concurrent operations on the same session/thread.
- **Phase-specific challenge lenses.** Editable `.txt` templates for shape, design, architecture, security, and code — loaded by the skill and passed through the prompt. No bridge rebuild needed to tune them.

---

## Prerequisites

- **Node.js 22+** (the SDK requires it)
- **Codex CLI** installed and authenticated — `codex --version` should work, and `~/.codex/` should have your auth config
- **Claude Code** ≥ the version that supports MCP servers and skills

If you use `nvm`, note the **PATH gotcha** below — Claude Code's MCP launcher does not inherit your interactive shell PATH.

---

## Install

### 1. Clone and build the MCP

```bash
git clone https://github.com/jieyun-yang/codex-bridge.git ~/codex-bridge
cd ~/codex-bridge/mcp
npm install
npm run build
```

This produces `~/codex-bridge/mcp/dist/index.js`, which is what you'll point Claude Code at.

### 2. Register the MCP server in `~/.claude.json`

Edit `~/.claude.json` and add a `codex` entry under `mcpServers`. **Use absolute paths everywhere** — Claude Code does not inherit your shell PATH:

```json
{
  "mcpServers": {
    "codex": {
      "type": "stdio",
      "command": "/Users/YOU/.nvm/versions/node/v22.19.0/bin/node",
      "args": [
        "/Users/YOU/codex-bridge/mcp/dist/index.js"
      ],
      "env": {
        "CODEX_BIN_PATH": "/Users/YOU/.bun/bin/codex",
        "PATH": "/Users/YOU/.nvm/versions/node/v22.19.0/bin:/Users/YOU/.bun/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Replace `/Users/YOU/...` with your real paths. Find your Node and Codex binaries with:

```bash
which node    # → use this for "command"
which codex   # → use this for CODEX_BIN_PATH
```

> **Why all the absolute paths?** Claude Code launches MCP servers without your interactive shell, so `node`, `codex`, and `PATH` are all unset. If you skip any of them you'll see one of these errors in the MCP logs:
> - `command not found: node` → fix `command`
> - `spawn codex ENOENT` → set `CODEX_BIN_PATH`
> - `Codex Exec exited with code 127: env: node: No such file or directory` → set `PATH` (the Codex CLI itself shells out to `node`)

### 3. Allow the MCP tools

In `~/.claude/settings.json`, add `mcp__codex` to `permissions.allow` so Claude can call the tools without prompting every time:

```json
{
  "permissions": {
    "allow": [
      "mcp__codex"
    ]
  }
}
```

### 4. (Optional) Install the `/codex-collab` skill

Symlink or copy the skill into your Claude Code skills directory:

```bash
ln -s ~/codex-bridge/skill/codex-collab ~/.claude/skills/codex-collab
# or, if you keep skills in ~/.agents/skills/:
ln -s ~/codex-bridge/skill/codex-collab ~/.agents/skills/codex-collab
```

Restart Claude Code. `/codex-collab` should now be available as a slash command.

---

## Usage

### Slash command (the easy path)

```
/codex-collab challenge ~/work/spec.md
/codex-collab code-review
/codex-collab delegate "Refactor the auth middleware to use the new session API."
```

The skill picks the right MCP tool for each mode:
- **challenge** → `codex_share_context` (capture `session_id`) → `codex_chat` with `output_format=challenge`. Optional phase lens: shape, design, architecture, security, code.
- **code-review** → `codex_code_review` (stateless, git-backed, structured output).
- **delegate** → `codex_share_context` → `codex_chat` with `output_format=text`. Multi-round friendly.

### Multi-round conversations

The pattern that works:

1. `codex_share_context` with the artifact text → returns `session_id`
2. `codex_chat` with that `session_id` and your first question → returns `thread_id`
3. `codex_chat` with `thread_id` for follow-ups

The `session_id` is one-shot (consumed on first use). All follow-ups use the `thread_id` returned by the first chat call. Threads stay in memory for 30 minutes after the last use; after that, `codex_chat` will re-resume from the SDK by ID.

### Calling the MCP tools directly

Any Claude Code agent or skill can call the tools as `mcp__codex__codex_chat`, `mcp__codex__codex_share_context`, etc. The skill is just one consumer.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: node` in MCP logs | `command` field uses bare `node` | Use absolute path, e.g. `/Users/YOU/.nvm/versions/node/v22.19.0/bin/node` |
| `spawn codex ENOENT` | `CODEX_BIN_PATH` not set | Add `CODEX_BIN_PATH` env var with absolute path to `codex` |
| `Codex Exec exited with code 127` | Codex CLI subprocess can't find `node` | Add `PATH` env var to MCP config |
| Structured output timeout | Challenge/review calls default to 300s | Pass higher `timeout_ms`, or simplify the prompt |
| `session_consumed` error | Reusing a `session_id` after first chat | Use `thread_id` from the chat response for follow-ups |
| `schema_validation_error` | Codex output didn't match the Zod schema | Retry (retryable), or switch to `output_format=text` |
| MCP not appearing in Claude Code | Server entry typo or not restarted | Check `~/.claude/logs/`. Restart Claude Code after editing `~/.claude.json`. |

---

## Configuration

Environment variables read by the MCP:

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_BIN_PATH` | `codex` (PATH lookup) | Absolute path to the `codex` CLI binary |
| `CODEX_DEFAULT_MODEL` | `gpt-5.4` | Default Codex model for all tools |

The 30-minute thread TTL and default timeouts (120s text, 300s structured) are constants in `mcp/src/codex-manager.ts` and `mcp/src/tools/chat.ts` — change them there and rebuild.

---

## Development

```bash
cd mcp
npm install
npm run build         # one-shot tsc
npm run dev           # tsc --watch
npm test              # vitest (34 contract tests)
```

The MCP entrypoint is `dist/index.js`. After rebuilding, restart Claude Code so it re-spawns the stdio process.

---

## License

MIT — see [LICENSE](LICENSE).

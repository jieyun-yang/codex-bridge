# codex-bridge

`codex-bridge` is a small toolkit for **Claude ↔ Codex collaboration** inside Claude Code.

It is designed for teams who want Codex to help with more than code review:
- plans
- specs
- architecture docs
- designs
- draft responses
- scoped implementation tasks

The project has two parts:

1. **`mcp/`** — a stdio MCP server that exposes Codex as narrow, agent-callable tools
2. **`skill/codex-collab/`** — a Claude Code skill (`/codex-collab`) that turns those tools into a usable workflow for humans

## Why choose this

Choose `codex-bridge` when your main need is **multi-round Claude ↔ Codex collaboration**, especially on non-code artifacts.

It is a good fit if you want:
- Claude to use Codex to review plans, specs, designs, architecture, or draft responses
- explicit `share_context → chat` workflows for iterative critique
- agents to call Codex programmatically through MCP tools
- a small integration that is easy to read, debug, and modify

What makes it different:
- it is **artifact-first**, not only code-review-first
- it is **agent-friendly**, not only user-command-driven
- it supports **multi-turn collaboration** on the same artifact
- it gives Claude **least-privilege Codex access** through MCP instead of broad shell access

## When not to choose this

Use the **official OpenAI Codex plugin for Claude Code** if you want:
- a ready-to-go experience with minimal configuration
- the ability to hand off long-running work, check status, and cancel
- code review and code-task delegation as your primary Codex use case

## What this gives you

### MCP tools
- `codex_share_context` — stage artifact context without consuming a Codex turn
- `codex_chat` — continue a multi-round Codex conversation; supports `output_format=challenge` for structured critique
- `codex_code_review` — structured code review for tracked git changes (untracked files excluded; `git add` first)
- `codex_list_sessions` — debug/recovery path for old Codex sessions

All tools return typed error envelopes with retry/resume guidance.

### Skill modes
- `challenge` — critique plans, specs, designs, architecture docs, responses, or any non-code artifact. Optional phase-specific lenses (shape, design, architecture, security, code) loaded from editable template files.
- `code-review` — review of code diffs
- `delegate` — hand a scoped task to Codex and continue the thread across rounds

## Quick examples

```text
/codex-collab challenge ./docs/plan.md
/codex-collab challenge ./spec.md
/codex-collab code-review
/codex-collab delegate "Refactor the auth middleware to use the new session API."
```

Or call the MCP tools directly from any agent:

```text
codex_share_context  →  session_id
codex_chat(session_id)  →  thread_id + response
codex_chat(thread_id)  →  follow-up response
```

---

## Project layout

```
codex-bridge/
├── mcp/                          # the stdio MCP server (v3.2.0)
│   ├── src/
│   │   ├── index.ts              # registers the 4 tools
│   │   ├── codex-manager.ts      # thread pool, mutex, TTL eviction, RuntimeOptions
│   │   ├── session-store.ts      # bridge-local capsule staging (session_id → thread_id)
│   │   ├── prompts.ts            # bridge-side system prompts (review + challenge)
│   │   ├── errors.ts             # typed error categories + classifyError
│   │   ├── utils.ts              # formatError, textResponse helpers
│   │   └── tools/
│   │       ├── chat.ts           # multi-turn chat + structured challenge output
│   │       ├── share-context.ts  # stage context capsule (bridge-local, no Codex turn)
│   │       ├── code-review.ts    # code review via git diff
│   │       └── sessions.ts       # list ~/.codex/session_index.jsonl (debug/recovery)
│   ├── test/                     # 21 contract tests (vitest)
│   ├── package.json
│   └── tsconfig.json
└── skill/
    └── codex-collab/             # the Claude Code skill (/codex-collab)
        ├── SKILL.md
        └── templates/            # phase-specific challenge lenses (editable .txt files)
```

---

## Prerequisites

- **Node.js 22+** (the SDK requires it)
- **Codex CLI** installed and authenticated — `codex --version` should work
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

### 2. Register the MCP server in `~/.claude.json`

**Use absolute paths everywhere** — Claude Code does not inherit your shell PATH:

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

Find your paths with:

```bash
which node    # → use for "command"
which codex   # → use for CODEX_BIN_PATH
```

### 3. Allow the MCP tools

In `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__codex"
    ]
  }
}
```

### 4. (Optional) Install the skill

```bash
ln -s ~/codex-bridge/skill/codex-collab ~/.agents/skills/codex-collab
```

Restart Claude Code. `/codex-collab` should now be available.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_BIN_PATH` | `codex` (PATH lookup) | Absolute path to the `codex` CLI binary |
| `CODEX_DEFAULT_MODEL` | `gpt-5.4` | Default Codex model for all tools |

Default timeout: 120s per call. Override with `timeout_ms`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: node` | Use absolute path in MCP config `command` field |
| `spawn codex ENOENT` | Set `CODEX_BIN_PATH` env var |
| `Codex Exec exited with code 127` | Add `PATH` to MCP config env |
| Codex call timeout | Pass higher `timeout_ms`, or simplify the prompt |
| `session_consumed` error | Use `thread_id` from the chat response for follow-ups |

---

## Development

```bash
cd mcp
npm install
npm run build         # one-shot tsc
npm run dev           # tsc --watch
npm test              # vitest (21 contract tests)
```

After rebuilding, restart Claude Code so it re-spawns the MCP server.

---

## License

MIT — see [LICENSE](LICENSE).

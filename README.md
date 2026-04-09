# codex-bridge

A two-piece toolkit for **Claude ↔ Codex collaboration** in Claude Code:

1. **`mcp/`** — A stdio MCP server (`codex-bridge`) that wraps the [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) Thread API. Gives Claude five tools: `codex_exec`, `codex_chat`, `codex_share_context`, `codex_review`, `codex_list_sessions`. Threads are pooled in-process with a 30-minute TTL and a per-thread mutex so multi-round conversations actually preserve context.
2. **`skill/codex-collab/`** — A Claude Code skill (`/codex-collab`) with three modes: **challenge** (critique any artifact), **code-review** (review uncommitted/branch/commit diffs), **delegate** (hand off a scoped task). The skill is the human-facing front door; the MCP is the engine.

The two pieces are independent — you can install just the MCP and call its tools directly, or install both for the slash-command UX.

---

## Why this exists (vs. the alternatives)

I tried two off-the-shelf options first. Both fell short for the workflow I wanted (multi-round adversarial review of plans, designs, and code — not just git diffs):

### vs. `codex@openai-codex` plugin

The official Codex plugin for Claude Code is built around a **review gate**: it shells out to `codex review` against a git diff, and that's it. Concretely:

| | `codex@openai-codex` plugin | `codex-bridge` |
|---|---|---|
| Plan/spec/design review | ❌ git-only | ✅ any artifact via `share_context → chat` |
| Multi-round conversation | ❌ stateless per call | ✅ Thread persists 30 min, history preserved |
| Context delivery | git diff only | arbitrary text/files via `share_context` |
| Resume an earlier review | ❌ no thread IDs surfaced | ✅ `codex_chat` with `threadId` |
| Task delegation | ❌ not a workflow it supports | ✅ `delegate` mode |

If you only ever want "review my uncommitted diff," the official plugin is fine. The moment you want to ask follow-up questions, share a non-git artifact, or hand off a scoped task, you hit a wall.

### vs. gstack `/codex` skill ([gstack-main/codex](https://github.com/garrytan/gstack))

gstack's `/codex` skill is a much more ambitious bash wrapper around the Codex CLI — three modes (review / challenge / consult), session continuity via files in `~/.gstack/sessions/`, telemetry, etc. It's well-built for what it is, but it's a **shell-script wrapper around `codex` the CLI**, not an MCP server. That has consequences:

| | gstack `/codex` skill | `codex-bridge` |
|---|---|---|
| Transport | bash → `codex` CLI subprocess per turn | persistent stdio MCP, in-process Thread pool |
| Multi-round state | filesystem session files | in-memory `Thread` objects (SDK-resumable by ID) |
| Concurrency safety | none (no per-session lock) | per-thread `WeakMap` mutex |
| Cold-start cost per turn | full CLI spawn each time | one SDK init, threads reused |
| Claude integration | skill-only (no MCP tools) | skill **and** raw MCP tools available to any agent |
| Lines of code | ~800 LOC bash + helpers | ~250 LOC TypeScript + ~90 LOC skill |

The big practical difference: with `codex-bridge`, **the same `Thread` object is reused across turns in the same conversation**, so Codex genuinely sees the prior turns instead of having to be re-primed from a session file. And because it's an MCP server, anything in your Claude Code setup (skills, agents, raw `mcp__codex__*` calls) can use it — not just the one `/codex` slash command.

### vs. rolling your own

The interesting bits are small but easy to get wrong. The MCP handles:

- **Thread pooling with TTL** — 30-min idle eviction, but never evicts a thread mid-turn (`activeTurns` counter).
- **Per-thread mutex via `WeakMap<Thread, Promise>`** — serializes concurrent turns on the same thread without leaking entries when the Thread is GC'd.
- **Timeout via `AbortController`** — distinct `TimeoutError` so the skill can react.
- **Auto-resume by ID** — `codex_chat` works on both in-pool threads and historical thread IDs (SDK `resumeThread()`).

See [`mcp/src/codex-manager.ts`](mcp/src/codex-manager.ts) — that's where all the lock/pool logic lives.

---

## What's in the box

```
codex-bridge/
├── mcp/                          # the stdio MCP server
│   ├── src/
│   │   ├── index.ts              # registers the 5 tools
│   │   ├── codex-manager.ts      # thread pool, mutex, TTL eviction
│   │   ├── utils.ts
│   │   └── tools/
│   │       ├── exec.ts           # one-shot task → returns threadId
│   │       ├── chat.ts           # follow-up on existing thread
│   │       ├── share-context.ts  # push context, no action
│   │       ├── review.ts         # codex review (git diff)
│   │       └── sessions.ts       # list ~/.codex/session_index.jsonl
│   ├── package.json
│   └── tsconfig.json
└── skill/
    └── codex-collab/             # the Claude Code skill (/codex-collab)
        ├── SKILL.md
        └── templates/            # phase prompts (shape, design, architecture, security, code) + code-review rubric
```

The MCP exposes **five tools**:

| Tool | Purpose |
|---|---|
| `codex_exec` | One-shot task; returns `{response, threadId}` for follow-up. |
| `codex_chat` | Continue an existing thread. Auto-resumes historical thread IDs. |
| `codex_share_context` | Push context to a thread without asking it to act. Use this **before** `codex_chat` for multi-round work. |
| `codex_review` | Run `codex review` against uncommitted / branch / commit diff. Stateless. |
| `codex_list_sessions` | List recent entries from `~/.codex/session_index.jsonl`. |

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

### 5. (Optional) Add a footer signal in `CLAUDE.md`

If you want a one-line debug signal whenever Codex was called, add this to your global `CLAUDE.md`:

```markdown
## Response Footer

End every response with a status line:

\`\`\`
---
agents: planner→generator | skill: codex-collab | profile: none
\`\`\`

When `codex-bridge` MCP was called this turn, add a second line:

\`\`\`
codex: ok | share_context→chat | r2 | 18s
\`\`\`

Format: `status | pattern | round | latency | optional note`. Status: `ok` / `error` / `timeout` / `degraded`. Pattern: MCP tool flow in call order. Round: `r1`/`r2`/`r3`. Note: only when something deviates. Omit this line when Codex was not called.
```

This makes it obvious when Codex was actually invoked vs. when Claude just talked about it. Useful while you're battle-testing the setup.

---

## Usage

### Slash command (the easy path)

```
/codex-collab challenge ~/work/spec.md
/codex-collab code-review
/codex-collab delegate "Refactor the auth middleware to use the new session API. Acceptance: existing tests pass, no behavior change."
```

The skill picks the right MCP tool for each mode:
- **challenge** and **delegate** → `codex_share_context` (capture `threadId`) → `codex_chat`. Multi-round friendly.
- **code-review** → `codex_review` (stateless, git-backed).

### Calling the MCP tools directly

Any Claude Code agent or skill can call the tools as `mcp__codex__codex_exec`, `mcp__codex__codex_chat`, etc. The skill is just one consumer.

### Multi-round conversations

The pattern that works:

1. `codex_share_context` with the artifact text → returns `threadId`
2. `codex_chat` with that `threadId` and your first question
3. `codex_chat` again with the same `threadId` for follow-ups

Threads stay in memory for 30 minutes after the last use. After that, `codex_chat` will silently re-resume from the SDK by ID — slightly slower cold-start, but conversation history is preserved.

**Avoid `codex_exec` for anything you might want to follow up on** — it works, but it doesn't surface context-sharing as a separate step, so the first turn is doing two jobs at once.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: node` in MCP logs | `command` field uses bare `node` | Use absolute path, e.g. `/Users/YOU/.nvm/versions/node/v22.19.0/bin/node` |
| `spawn codex ENOENT` | `CODEX_BIN_PATH` not set | Add `CODEX_BIN_PATH` env var with absolute path to `codex` |
| `Codex Exec exited with code 127: env: node: No such file or directory` | Codex CLI subprocess can't find `node` | Add `PATH` env var to MCP config so the Codex CLI subprocess inherits it |
| `codex_chat` validation error on `timeout_ms` | Passing as string | Omit it (uses default 120000 ms) or pass as number |
| Codex "forgets" the context across rounds | Using `codex_exec` per turn instead of one `share_context → chat → chat` | Use `codex_share_context` once, then `codex_chat` with the returned `threadId` |
| MCP not appearing in Claude Code | Server entry typo or not restarted | `~/.claude/logs/` will show stdio errors. Restart Claude Code after editing `~/.claude.json`. |

---

## Configuration

Environment variables read by the MCP:

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_BIN_PATH` | `codex` (PATH lookup) | Absolute path to the `codex` CLI binary |
| `CODEX_DEFAULT_MODEL` | `gpt-5.4` | Default Codex model passed to `startThread` and `codex review -c model=...` |

The 30-minute thread TTL and 120-second per-call timeout are constants in `mcp/src/codex-manager.ts` — change them there and rebuild.

---

## Development

```bash
cd mcp
npm install
npm run build         # one-shot tsc
npm run dev           # tsc --watch
```

The MCP entrypoint is `dist/index.js`. After rebuilding, restart Claude Code (or whatever client) so it re-spawns the stdio process.

---

## License

MIT — see [LICENSE](LICENSE).

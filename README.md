# codex-bridge

A two-piece toolkit for **Claude ↔ Codex collaboration** in Claude Code:

1. **`mcp/`** — A stdio MCP server (`codex-bridge`) that wraps the [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) Thread API. Gives Claude five tools: `codex_exec`, `codex_chat`, `codex_share_context`, `codex_review`, `codex_list_sessions`. Threads are pooled in-process with a 30-minute TTL and a per-thread mutex so multi-round conversations actually preserve context.
2. **`skill/codex-collab/`** — A Claude Code skill (`/codex-collab`) with three modes: **challenge** (critique any artifact), **code-review** (review uncommitted/branch/commit diffs), **delegate** (hand off a scoped task). The skill is the human-facing front door; the MCP is the engine.

The two pieces are independent — you can install just the MCP and call its tools directly, or install both for the slash-command UX.

---

## Why this exists (vs. the alternatives)

Two off-the-shelf options exist. Both are real, working tools — `codex-bridge` is differentiated on **transport and integration shape**, not on whether the other tools "support multi-round" or "support delegation." They both do. If you mostly drive Codex from the user prompt, the alternatives below may be a better starting point.

### vs. [`codex@openai-codex`](https://github.com/openai/codex-plugin-cc) plugin

OpenAI's official plugin exposes `/codex:review`, `/codex:adversarial-review` (for challenging design/implementation choices), `/codex:rescue` (delegate a task to a Codex subagent, with `--resume` and `--fresh` flags), plus `/codex:status`, `/codex:result`, `/codex:cancel`, and an opt-in review gate via `/codex:setup --enable-review-gate`. Session IDs are surfaced via `/codex:result` (when available) and `/codex:status`, so you can resume in Codex itself.

The contrast isn't "git-only vs. flexible." It's about **integration shape**. The table below compares the threaded artifact-critique / delegation workflows on both sides — both products also have a dedicated git-review path (`/codex:review` and `codex_review` respectively) which is stateless and not what this row is about.

| | `codex@openai-codex` plugin | `codex-bridge` |
|---|---|---|
| Surface | Slash commands (`/codex:*`) | MCP tools (`mcp__codex__*`) **+** companion skill |
| Who can invoke | User via slash commands; review gate also runs as a stop hook | Any agent, skill, or workflow that calls MCP tools |
| Free-form focus / context with the request | `/codex:adversarial-review` takes focus text; `/codex:rescue` takes a task description | Standalone `codex_share_context` tool — explicit "push context, no action" primitive composed with `codex_chat` |
| Threaded multi-round | Yes — `/codex:rescue --resume`, jobs/status/result flow | Yes — same `Thread` object reused in-process, with SDK `resumeThread(id)` as fallback |
| Per-turn cold-start (threaded path) | Not documented; treat as unspecified | One SDK init, subsequent turns are in-process method calls on a pooled `Thread` |
| Concurrency on the threaded path | Not documented | In-process `Thread` pool with per-thread `WeakMap` mutex |

> Note: `codex-bridge`'s own `codex_review` tool also shells out to `codex review` via `execFile` — the in-process / Thread-pool advantage applies to the `share_context → chat` path (challenge + delegate modes), not to code review.

**When the official plugin is the right pick:** you want the polished, OpenAI-maintained slash-command + hook UX for **your own** Codex use, and you don't need agent-driven invocation. (If you do want agents to invoke Codex, the plugin doesn't add anything — agents would shell out to `codex exec` directly anyway, the same way gstack does.)

**When `codex-bridge` is the right pick:** you have agents that need to call Codex programmatically and you want a **least-privilege tool grant**. You can hand an agent the narrow `mcp__codex__*` tools without also handing it `Bash` (which is the alternative if you want agent-driven Codex calls — Bash is a generic escape hatch that grants far more than "ask Codex a question"). You also get `share_context` as an explicit primitive so context-push and ask-question are two composable steps, and structured `{response, threadId}` data instead of stdout blobs to parse.

### vs. [gstack `/codex`](https://github.com/garrytan/gstack/blob/main/codex/SKILL.md) skill

gstack's `/codex` skill is a thoroughly built Claude Code skill that wraps the Codex CLI. It has three modes (review / challenge / consult), opt-in telemetry, and a careful preamble that handles routing, upgrade checks, and session bookkeeping. Multi-round consult mode works by saving the Codex session ID to `.context/codex-session-id` and resuming with `codex exec resume <session-id>` — so Codex itself preserves the thread, gstack just remembers the ID.

So the contrast isn't "files vs. real state." Both rely on Codex's own session continuity. It's about **transport** and **integration shape**:

| | gstack `/codex` skill | `codex-bridge` |
|---|---|---|
| Transport | Bash → `codex` CLI subprocess per turn | Persistent stdio MCP, in-process `Thread` pool (for threaded chat / delegate; `codex_review` still shells out to `codex review`) |
| Multi-round state | Codex session ID persisted to a file, resumed via `codex exec resume` | Same `Thread` object reused in-process; SDK `resumeThread(id)` as fallback |
| Cold-start per turn (threaded path) | New `codex` process each turn | One SDK init; subsequent turns are in-process method calls |
| Claude integration | Skill only (Bash/Read/Write/Glob/Grep tools) | MCP server **+** companion skill — any agent can call the MCP tools |
| Implementation size | ~1,075-line `SKILL.md` + ~1,748-line `SKILL.md.tmpl` (skill template, not bash script) | 410 lines of TypeScript across `mcp/src` + 84-line skill |
| Extras | Telemetry, upgrade flow, repo-mode detection, preamble | None of that — single-purpose |

**When gstack `/codex` is the right pick:** you're **already** using gstack for the rest of its toolkit (QA, ship, design-review, etc.), so the codex skill comes along for free.

**When gstack `/codex` is *not* a great fit:** you'd be installing gstack just for the codex skill. The bundling tax is real — gstack is a 30-skill toolkit with telemetry, upgrade flow, repo-mode detection, and a long preamble template. And the per-invocation cost is real too: every time the skill activates, its ~1,075-line `SKILL.md` (~6–8K tokens) gets loaded into your context budget before any work happens.

**When `codex-bridge` is the right pick:**
- **Least-privilege agent grant.** Hand an agent the narrow `mcp__codex__*` tools without also handing it `Bash` (which is the alternative if you want agent-driven Codex calls — `Bash` is a generic escape hatch granting far more than "ask Codex a question").
- **Cheap to load.** ~84-line skill (~500 tokens) plus the MCP tool descriptions — meaningfully smaller than gstack's per-invocation context tax.
- **No CLI cold-start on the threaded path.** `share_context → chat → chat` reuses an in-process `Thread`, avoiding the ~1–3s `codex exec` spawn per turn.
- **Single-purpose.** A small TypeScript MCP + thin skill you can read end-to-end when something breaks.

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

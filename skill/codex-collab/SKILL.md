---
name: codex-collab
description: >
  Claude-Codex collaboration. Challenge artifacts, review code, or delegate tasks to Codex.
  Invocation: /codex-collab <mode> <target>
triggers:
  - "/codex-collab"
user-invocable: true
---

# /codex-collab

Cross-model collaboration via `codex-bridge` MCP. Three modes: challenge, code-review, delegate.

## Shared Behavior

### Tool pattern
- **First call** (challenge + delegate): `codex_share_context` (push artifact/context) → capture the returned `threadId` → `codex_chat` with that `threadId` (give the task)
- **Follow-ups**: `codex_chat` with the same `threadId`
- **Exception**: code-review uses `codex_review` (standalone, no threads)
- Never use `codex_exec`. Always start with `share_context` → `chat` so multi-round is available.

### Resume logic (challenge + delegate only)
- If a threadId from a prior Codex call exists in this conversation AND the request is a continuation, use `codex_chat` with that threadId.
- If the artifact file was modified since the last round (check file modification time or re-read and compare), tell the user the basis changed and start a fresh thread.
- If no threadId is available or the thread expired (30-min TTL), start fresh and tell the user why.

### Thread tracking (challenge + delegate only)
After every Codex call in threaded modes, remember the threadId internally. On follow-up, use the threadId from the most recent Codex call in this conversation that matches the current mode and artifact.

### Findings format
Codex returns raw text. Claude presents findings in this canonical markdown format:
```
- **[MUST-FIX | high]** Description of issue
  → Suggested fix

- **[SHOULD-FIX | high]** Description of concern
  → Suggested approach

- **[CONSIDER | med]** Lower-priority observation
  → Suggested approach
```
Labels: MUST-FIX (blocking) / SHOULD-FIX (non-blocking, high confidence) / CONSIDER (non-blocking).

### Error handling
If any MCP tool call fails, tell the user what failed and whether the thread is resumable. Do not silently retry or switch tools.

## Mode 1: challenge

Critique any artifact — plans, specs, designs, architecture docs. Constructive feedback + find blindspots.

**Flow:**
1. Read the artifact the user specified
2. Determine the phase: shape, design, architecture, security, or code. Ask if unclear.
3. Load the phase template from `~/.agents/skills/codex-collab/templates/<phase>.txt`
4. Call `codex_share_context` with the artifact content → capture `threadId`
5. Call `codex_chat` with `threadId`, the phase template, and instruction to critique the artifact
6. Present findings in canonical format
7. Follow-up rounds: `codex_chat` on the same thread

**What to judge against:** The user provides context, or Claude asks. No hardcoded filenames.

## Mode 2: code-review

Code review via Codex.

**Flow:**
1. Determine target: uncommitted changes (default), branch diff, or specific commit
2. Call `codex_review` with target and working directory
3. Present Codex findings in canonical format, filtered through the rubric in `~/.agents/skills/codex-collab/templates/code-review-rubric.txt` (Claude uses the rubric to prioritize and filter Codex's raw output — the rubric is not sent to Codex)
4. Post-review checklist: for each item (tests pass, lint pass, security concerns), mark as verified, not verified, or unknown. Do not claim status without evidence.

**Stateless** — no threads, no resume capsule. Follow-ups rerun `codex_review` with a focused prompt (e.g. "focus on security"), not thread resume.

## Mode 3: delegate

Hand off a scoped task to Codex.

**Flow:**
1. Define acceptance criteria before delegation (ask user if not provided)
2. Call `codex_share_context` with task context + acceptance criteria → capture `threadId`
3. Call `codex_chat` with `threadId` and the task instruction
4. Present result
5. Follow-ups via `codex_chat` on the same thread

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

Requires the `codex-bridge` MCP server. Without it, all `codex_*` calls fail.

Three modes: **code-review** (code specifically), **challenge** (plans, specs, designs, any non-code artifact), **delegate** (scoped tasks).

**Which tool:** `codex_code_review` is strictly for code — diffs, files, generated code. For plans, specs, designs, responses, or any non-code artifact, use `codex_chat` with `output_format=challenge`. The tool name is the disambiguator — if you're not reviewing code, don't use `codex_code_review`.

## Shared rules

**Identity model.** `codex_share_context` is bridge-local — it does NOT consume a Codex turn. It returns a `session_id` (`ctx_<uuid>`). The first `codex_chat` after staging takes that `session_id`; the bridge lazy-creates the Codex thread, injects the capsule, and returns a real `thread_id` in the response. All follow-ups use `thread_id`. The session_id is single-use and rejected on reuse.

**Resume.** Remember the `thread_id` from each `codex_chat` response. On follow-up, call `codex_chat` with that `thread_id`. If the artifact file changed since the last round (mtime check or re-read), tell the user the basis changed and start a fresh session via a new `codex_share_context`. Bridge thread cache evicts after 30 minutes idle, but the underlying Codex thread is still resumable — eviction is not expiry.

**Errors.** All `codex_*` errors return a typed JSON envelope with `category`, `retryable`, `resumable`, `next_step`, and `context`. Parse the envelope to decide what to do — don't guess from the message string. Key categories:
- `timeout` (retryable) — retry with higher `timeout_ms` or simplify the prompt
- `codex_missing` / `auth_missing` (not retryable) — follow the `next_step` in the error envelope (install Codex or set API key)
- `session_consumed` (not retryable) — use `thread_id` from the prior success, or stage a new session
- `schema_parse_error` / `schema_validation_error` (retryable, capsule preserved) — retry or switch to `output_format=text`
- `review_target_invalid` / `diff_empty` / `diff_too_large` — caller error, fix the inputs

When any error has `retryable: false`, do not silently retry. Tell the user what failed and surface the `next_step` from the envelope.

## Mode: code-review

Structured review of CODE specifically. Only use when the user explicitly asks for code review. For anything else (plans, specs, responses, designs) use the challenge mode below.

1. Determine target: `uncommitted` (default), `branch` (with `base_branch`), or `commit` (with `commit_sha`).
2. Optionally set `focus`: `balanced` (default), `security`, `architecture`, `performance`, or `challenge`.
3. Call `codex_code_review` with target + focus + working_dir.
4. The response includes `result` — a typed `ReviewResult` with `findings[]` and `pressure_test[]`. Render it (see "Findings format" below).
5. Post-review checklist: for tests pass, lint pass, security concerns — mark verified, not verified, or unknown. Do not claim status without evidence.

**Stateless.** No threads, no resume. Follow-ups (e.g. "focus on security") rerun `codex_code_review` with `focus=security`, not a thread continuation.

## Mode: challenge

Critique any artifact — plans, specs, designs, architecture docs, proposed code, Claude responses.

1. Read the artifact the user specified.
2. Determine the **phase** (optional — ask if unclear, omit for general-purpose critique):
   - `shape` — early-stage problem framing, scope definition, success criteria
   - `design` — UI flows, interaction models, information architecture, component specs
   - `architecture` — system design, service boundaries, data models, migration plans
   - `security` — auth design, API surface, data handling, access control, threat models
   - `code` — proposed/pasted/generated code reviewed as text (not a git diff — use code-review mode for that)
3. If a phase is selected, load the template from `~/.agents/skills/codex-collab/templates/<phase>.txt`. These templates contain domain-specific focus areas and anti-patterns that sharpen the critique. Editable without a bridge rebuild.
4. Call `codex_share_context` with the artifact content + working_dir → capture `session_id`.
5. Call `codex_chat` with `session_id`, the critique instruction (include the template content in the prompt if loaded), and **`output_format: "challenge"`**. Capture `thread_id` from the response.
6. The response includes `result` — a typed `ChallengeResult` with `issues[]`. Render it (see "Findings format" below).
7. Follow-up rounds: `codex_chat` with `thread_id` and the same `output_format: "challenge"` to keep structured output sticky. Include the template again on follow-ups to keep the phase lens sticky.

## Mode: delegate

Hand off a scoped task to Codex.

1. Define acceptance criteria before delegation. Ask the user if not provided.
2. Call `codex_share_context` with task context + acceptance criteria → capture `session_id`.
3. Call `codex_chat` with `session_id` and the task instruction. Default `output_format: "text"` — delegate output is free-text.
4. Capture `thread_id` from the response. Present result to the user.
5. Follow-ups via `codex_chat` with `thread_id`.

## Findings format

Structured output (code-review and challenge) is rendered into this canonical markdown:

```
- **[MUST-FIX | high]** Title
  → Concrete fix
  Why: rationale

- **[SHOULD-FIX | med]** Title
  → Concrete fix
  Why: rationale

- **[CONSIDER | low]** Title
  → Concrete fix
  Why: rationale
```

Severity maps from the schema enum: `must_fix → MUST-FIX`, `should_fix → SHOULD-FIX`, `consider → CONSIDER`. Confidence prints alongside severity. For code-review, render `findings[]` first, then a `## Pressure test` section with `pressure_test[]`. For challenge, render `issues[]` only.

When `strengths[]` is non-empty, surface it under a `## What's working` heading BEFORE the issues/findings. This is deliberate ordering — leading with what's right protects good decisions from being lost in the noise of critique, and frames the rest of the review constructively. Render each strength as a bullet, no severity tags. If `strengths[]` is empty, omit the section entirely (don't render an empty heading).

When `confidence_notes[]` is non-empty, surface it under a `## Coverage gaps` heading AFTER the findings — it's the model telling you what it could NOT verify.

**Runtime controls.** All threaded tools (`codex_chat`, `codex_code_review`) accept optional `model`, `reasoning_effort` (minimal/low/medium/high/xhigh), and `sandbox_mode` (read-only/workspace-write/danger-full-access). These are set at thread creation time — on follow-up turns with an existing `thread_id`, they are ignored (SDK limitation). Default model is `gpt-5.4`.

## Recovery

If you've lost a `thread_id` and need to find an old Codex thread, call `codex_list_sessions` to scan `~/.codex/session_index.jsonl`. This is a debug/recovery path only — not part of normal flow.

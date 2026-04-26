/**
 * Tool-level tests for codex_share_context.
 *
 * No SDK mocking needed — this tool is bridge-local (no Codex turn). Real
 * session-store; we reset between tests.
 */

import { describe, it, expect, beforeEach } from "vitest";

describe("codex_share_context tool", () => {
  beforeEach(async () => {
    const sessionStore = await import("../../src/session-store.js");
    sessionStore.reset();
  });

  it("creates a new session_id when called with neither id", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({ context: "hello", mode: "replace" } as any);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.session_id).toMatch(/^ctx_/);
    expect(body.thread_id).toBeNull();
    expect(body.state).toBe("staged");
    expect(body.context_version).toBe(1);
  });

  it("rejects when both session_id and thread_id are provided", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({
      context: "hello",
      session_id: "ctx_x",
      thread_id: "thread-1",
      mode: "replace",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("identity_ambiguous");
  });

  it("rejects mode=append on a thread_id (would duplicate server-side context)", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({
      context: "extra",
      thread_id: "thread-existing",
      mode: "append",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("stage_rejected");
  });

  it("rejects malformed session_id", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({
      context: "hi",
      session_id: "not-a-real-id",
      mode: "replace",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("session_invalid");
  });

  it("rejects thread_id that starts with ctx_ (namespace collision)", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({
      context: "hi",
      thread_id: "ctx_should-be-session",
      mode: "replace",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("namespace_collision");
  });

  it("rejects staging into a consumed session_id", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const sessionStore = await import("../../src/session-store.js");

    const { key } = sessionStore.stage("ctx", "replace");
    sessionStore.markConsumed(key);

    const result = await shareContextTool({
      context: "another",
      session_id: key,
      mode: "replace",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("session_consumed");
  });

  it("accepts mode=replace with a thread_id (only path that's allowed)", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const result = await shareContextTool({
      context: "fresh basis",
      thread_id: "thread-existing",
      mode: "replace",
    } as any);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.session_id).toBeNull();
    expect(body.thread_id).toBe("thread-existing");
    expect(body.state).toBe("staged");
  });

  it("preserves session_id when updating an existing staged capsule", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");

    const first = await shareContextTool({ context: "v1", mode: "replace" } as any);
    const firstBody = JSON.parse(first.content[0].text);
    const sid = firstBody.session_id;

    const second = await shareContextTool({ context: "v2", session_id: sid, mode: "replace" } as any);
    const secondBody = JSON.parse(second.content[0].text);
    expect(secondBody.session_id).toBe(sid);
    expect(secondBody.context_version).toBeGreaterThan(firstBody.context_version);
  });

  it("appends additional context with mode=append on a session_id", async () => {
    const { shareContextTool } = await import("../../src/tools/share-context.js");
    const sessionStore = await import("../../src/session-store.js");

    const first = await shareContextTool({ context: "v1", mode: "replace" } as any);
    const sid = JSON.parse(first.content[0].text).session_id;

    const second = await shareContextTool({ context: "v2", session_id: sid, mode: "append" } as any);
    expect(second.isError).toBeFalsy();
    expect(JSON.parse(second.content[0].text).merge_mode).toBe("append");

    // Verify the entry actually has accumulated content.
    const entry = sessionStore.peek(sid);
    expect(entry?.context).toContain("v1");
    expect(entry?.context).toContain("v2");
  });
});

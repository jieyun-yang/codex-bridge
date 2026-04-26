/**
 * Tool-level integration tests for codex_chat.
 *
 * Mocks the codex-manager boundary (SDK Codex/Thread). Real session-store,
 * real mode-store (rooted under a temp HOME). Covers the cases the
 * helper-only test suite couldn't catch:
 *
 * - identity validation (both / neither / malformed / namespace collision)
 * - session_consumed after the first turn
 * - challenge injection on session_id flow (and mode recording)
 * - mode_mismatch on thread_id resume when not born in challenge mode
 * - clean resume when challenge-mode thread is replayed in challenge mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runOnThreadMock = vi.fn();
const startThreadMock = vi.fn();
const resumeThreadMock = vi.fn();
let nextThreadId = "thread-mock-1";

vi.mock("../../src/codex-manager.js", () => {
  return {
    startThread: (...args: unknown[]) => startThreadMock(...args),
    resumeThread: (...args: unknown[]) => resumeThreadMock(...args),
    runOnThread: (...args: unknown[]) => runOnThreadMock(...args),
    getThreadId: (thread: { id: string }) => thread.id,
    getDefaultTimeoutMs: () => 300_000,
  };
});

describe("codex_chat tool", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "codex-bridge-chat-test-"));
    process.env.HOME = tempHome;
    vi.resetModules();

    runOnThreadMock.mockReset().mockResolvedValue("mock response");
    nextThreadId = "thread-mock-1";
    startThreadMock.mockReset().mockImplementation(() => ({ id: nextThreadId }));
    resumeThreadMock.mockReset().mockImplementation((id: string) => ({ id }));

    // Reset session-store global state.
    const sessionStore = await import("../../src/session-store.js");
    sessionStore.reset();
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  it("rejects when neither session_id nor thread_id is provided", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const result = await chatTool({ prompt: "hi", output_format: "text", focus: "balanced", context_behavior: "consume" } as any);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("identity_ambiguous");
  });

  it("rejects when both session_id and thread_id are provided", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const result = await chatTool({
      prompt: "hi",
      session_id: "ctx_abc",
      thread_id: "thread-1",
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).category).toBe("identity_ambiguous");
  });

  it("rejects malformed session_id (no ctx_ prefix)", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const result = await chatTool({
      prompt: "hi",
      session_id: "bogus-id",
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("session_invalid");
  });

  it("rejects thread_id that starts with ctx_ (namespace collision)", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const result = await chatTool({
      prompt: "hi",
      thread_id: "ctx_should-be-session",
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("namespace_collision");
  });

  it("first turn after session_id records mode=text and succeeds", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const sessionStore = await import("../../src/session-store.js");
    const modeStore = await import("../../src/mode-store.js");

    const { key } = sessionStore.stage("background context", "replace");
    nextThreadId = "thread-text-1";

    const result = await chatTool({
      prompt: "hello",
      session_id: key,
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.thread_id).toBe("thread-text-1");
    expect(body.context_consumed).toBe(true);
    expect(modeStore.getThreadMode("thread-text-1")).toBe("text");
  });

  it("first turn after session_id with output_format=challenge records mode=challenge AND injects the prompt", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const sessionStore = await import("../../src/session-store.js");
    const modeStore = await import("../../src/mode-store.js");

    const { key } = sessionStore.stage("review this", "replace");
    nextThreadId = "thread-challenge-1";

    const result = await chatTool({
      prompt: "critique it",
      session_id: key,
      output_format: "challenge",
      focus: "balanced",
      context_behavior: "consume",
    } as any);

    expect(result.isError).toBeFalsy();
    expect(modeStore.getThreadMode("thread-challenge-1")).toBe("challenge");

    // Verify the challenge system prompt was prepended on this turn.
    expect(runOnThreadMock).toHaveBeenCalledTimes(1);
    const sentPrompt = runOnThreadMock.mock.calls[0][1] as string;
    expect(sentPrompt).toContain("[SYSTEM INSTRUCTION]");
    expect(sentPrompt).toContain("Critical reviewer");
  });

  it("rejects output_format=challenge on a thread_id that wasn't born in challenge mode", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const modeStore = await import("../../src/mode-store.js");

    modeStore.recordThreadMode("thread-text-2", "text");

    const result = await chatTool({
      prompt: "now critique",
      thread_id: "thread-text-2",
      output_format: "challenge",
      focus: "balanced",
      context_behavior: "ignore",
    } as any);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("mode_mismatch");
    expect(envelope.context.thread_id).toBe("thread-text-2");
    expect(envelope.context.recorded).toBe("text");
  });

  it("rejects output_format=challenge on a thread_id with no recorded mode", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const result = await chatTool({
      prompt: "critique",
      thread_id: "thread-unknown",
      output_format: "challenge",
      focus: "balanced",
      context_behavior: "ignore",
    } as any);

    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("mode_mismatch");
    expect(envelope.context.recorded).toBe("no record");
  });

  it("accepts output_format=challenge on a thread_id recorded as challenge mode", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const modeStore = await import("../../src/mode-store.js");

    modeStore.recordThreadMode("thread-challenge-2", "challenge");

    const result = await chatTool({
      prompt: "follow up",
      thread_id: "thread-challenge-2",
      output_format: "challenge",
      focus: "balanced",
      context_behavior: "ignore",
    } as any);

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.thread_id).toBe("thread-challenge-2");
    // Challenge prompt is NOT re-injected on follow-ups (framing in turn-1 history).
    const sentPrompt = runOnThreadMock.mock.calls[0][1] as string;
    expect(sentPrompt).not.toContain("[SYSTEM INSTRUCTION]");
  });

  it("rejects a re-used session_id (one-shot)", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const sessionStore = await import("../../src/session-store.js");

    const { key } = sessionStore.stage("ctx", "replace");
    nextThreadId = "thread-once";

    // First call consumes the session.
    await chatTool({
      prompt: "first",
      session_id: key,
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);

    // Second call must fail.
    const result = await chatTool({
      prompt: "second",
      session_id: key,
      output_format: "text",
      focus: "balanced",
      context_behavior: "consume",
    } as any);

    expect(JSON.parse(result.content[0].text).category).toBe("session_consumed");
  });

  it("rejects context_behavior=ignore with session_id (sessions are one-shot)", async () => {
    const { chatTool } = await import("../../src/tools/chat.js");
    const sessionStore = await import("../../src/session-store.js");
    const { key } = sessionStore.stage("ctx", "replace");

    const result = await chatTool({
      prompt: "skip",
      session_id: key,
      output_format: "text",
      focus: "balanced",
      context_behavior: "ignore",
    } as any);

    expect(JSON.parse(result.content[0].text).category).toBe("stage_rejected");
  });
});

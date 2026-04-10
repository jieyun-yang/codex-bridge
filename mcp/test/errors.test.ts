import { describe, it, expect } from "vitest";
import { typedError } from "../src/errors.js";

describe("typedError", () => {
  it("returns an MCP error shape with isError=true", () => {
    const result = typedError("timeout", "codex_chat");
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("embeds a parseable JSON envelope in the text content", () => {
    const result = typedError("session_consumed", "codex_chat", { session_id: "ctx_123" });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("session_consumed");
    expect(envelope.tool).toBe("codex_chat");
    expect(envelope.context.session_id).toBe("ctx_123");
    expect(typeof envelope.retryable).toBe("boolean");
    expect(typeof envelope.resumable).toBe("boolean");
    expect(typeof envelope.next_step).toBe("string");
  });

  it("uses the message override when provided", () => {
    const result = typedError("timeout", "codex_chat", {}, "custom message");
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.message).toBe("custom message");
  });

  it("generates a default message from tool+category when no override", () => {
    const result = typedError("codex_missing", "codex_chat");
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.message).toBe("codex_chat failed: codex_missing");
  });

  it("marks timeout as retryable and resumable", () => {
    const envelope = JSON.parse(typedError("timeout", "codex_chat").content[0].text);
    expect(envelope.retryable).toBe(true);
    expect(envelope.resumable).toBe(true);
  });

  it("marks codex_missing as non-retryable and non-resumable", () => {
    const envelope = JSON.parse(typedError("codex_missing", "codex_chat").content[0].text);
    expect(envelope.retryable).toBe(false);
    expect(envelope.resumable).toBe(false);
  });

  it("marks identity_ambiguous as non-retryable but resumable", () => {
    const envelope = JSON.parse(typedError("identity_ambiguous", "codex_chat").content[0].text);
    expect(envelope.retryable).toBe(false);
    expect(envelope.resumable).toBe(true);
  });
});

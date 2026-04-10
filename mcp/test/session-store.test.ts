import { describe, it, expect, beforeEach } from "vitest";

// Import from source — vitest resolves .ts natively.
import {
  stage,
  peek,
  consume,
  reset,
  newSessionId,
  isSessionId,
  isConsumed,
  markConsumed,
  acquireKeyLock,
  SESSION_PREFIX,
} from "../src/session-store.js";

describe("session-store", () => {
  // NOTE: the store is module-level state. Tests are not fully isolated.
  // For this test suite, that's acceptable — we use fresh session IDs per test.

  describe("newSessionId / isSessionId", () => {
    it("generates IDs with the ctx_ prefix", () => {
      const id = newSessionId();
      expect(id.startsWith(SESSION_PREFIX)).toBe(true);
      expect(isSessionId(id)).toBe(true);
    });

    it("rejects non-prefixed strings", () => {
      expect(isSessionId("thread_abc")).toBe(false);
      expect(isSessionId("")).toBe(false);
    });
  });

  describe("stage / peek / consume lifecycle", () => {
    it("stages a new capsule and peeks it", () => {
      const { key, entry } = stage("hello", "replace");
      expect(isSessionId(key)).toBe(true);
      expect(entry.context).toBe("hello");
      expect(entry.version).toBe(1);
      expect(entry.mergeMode).toBe("replace");

      const peeked = peek(key);
      expect(peeked).toBeDefined();
      expect(peeked!.context).toBe("hello");
    });

    it("consume returns and removes the capsule", () => {
      const { key } = stage("consume-me", "replace");
      const consumed = consume(key);
      expect(consumed).toBeDefined();
      expect(consumed!.context).toBe("consume-me");

      // Second consume returns undefined.
      expect(consume(key)).toBeUndefined();
      expect(peek(key)).toBeUndefined();
    });

    it("peek does not remove the capsule", () => {
      const { key } = stage("peek-me", "replace");
      expect(peek(key)).toBeDefined();
      expect(peek(key)).toBeDefined(); // still there
    });

    it("reset removes without returning", () => {
      const { key } = stage("reset-me", "replace");
      expect(reset(key)).toBe(true);
      expect(peek(key)).toBeUndefined();
      expect(reset(key)).toBe(false); // already gone
    });
  });

  describe("merge modes", () => {
    it("replace overwrites previous content", () => {
      const { key } = stage("first", "replace");
      stage("second", "replace", key);
      expect(peek(key)!.context).toBe("second");
      expect(peek(key)!.version).toBe(2);
    });

    it("append concatenates with blank line separator", () => {
      const { key } = stage("line1", "replace");
      stage("line2", "append", key);
      expect(peek(key)!.context).toBe("line1\n\nline2");
      expect(peek(key)!.version).toBe(2);
    });

    it("append on empty key behaves like replace", () => {
      const key = newSessionId();
      stage("first-append", "append", key);
      expect(peek(key)!.context).toBe("first-append");
    });
  });

  describe("working_dir storage", () => {
    it("stores workingDir and makes it sticky across stages", () => {
      const { key } = stage("ctx", "replace", undefined, "/some/dir");
      expect(peek(key)!.workingDir).toBe("/some/dir");

      // Replace without workingDir preserves the previous value.
      stage("ctx2", "replace", key);
      expect(peek(key)!.workingDir).toBe("/some/dir");

      // Explicit new workingDir overrides.
      stage("ctx3", "replace", key, "/other/dir");
      expect(peek(key)!.workingDir).toBe("/other/dir");
    });
  });

  describe("consumed session tracking", () => {
    it("marks and checks consumed sessions", () => {
      const id = newSessionId();
      expect(isConsumed(id)).toBe(false);
      markConsumed(id);
      expect(isConsumed(id)).toBe(true);
    });

    it("non-consumed sessions return false", () => {
      expect(isConsumed("ctx_never-consumed")).toBe(false);
    });
  });

  describe("acquireKeyLock", () => {
    it("serializes concurrent operations on the same key", async () => {
      const key = newSessionId();
      const order: number[] = [];

      const release1 = await acquireKeyLock(key);
      // Start a second acquire that won't resolve until release1.
      const p2 = acquireKeyLock(key).then((release2) => {
        order.push(2);
        release2();
      });

      order.push(1);
      release1();
      await p2;

      expect(order).toEqual([1, 2]);
    });

    it("does not block operations on different keys", async () => {
      const keyA = newSessionId();
      const keyB = newSessionId();

      const releaseA = await acquireKeyLock(keyA);
      // This should resolve immediately since keyB is independent.
      const releaseB = await acquireKeyLock(keyB);

      releaseA();
      releaseB();
    });
  });
});

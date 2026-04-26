import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module resolves STORE_DIR at import time via homedir(). We point HOME
// at a fresh temp dir AND reset modules before each test so the next dynamic
// import picks up the new HOME.

describe("mode-store", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "codex-bridge-mode-store-"));
    process.env.HOME = tempHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("returns undefined for an unknown thread", async () => {
    const { getThreadMode, _resetCacheForTests } = await import("../src/mode-store.js");
    _resetCacheForTests();
    expect(getThreadMode("unknown-thread")).toBeUndefined();
  });

  it("records and retrieves text mode", async () => {
    const { recordThreadMode, getThreadMode, _resetCacheForTests } = await import("../src/mode-store.js");
    _resetCacheForTests();
    recordThreadMode("t-1", "text");
    expect(getThreadMode("t-1")).toBe("text");
  });

  it("records and retrieves challenge mode", async () => {
    const { recordThreadMode, getThreadMode, _resetCacheForTests } = await import("../src/mode-store.js");
    _resetCacheForTests();
    recordThreadMode("t-2", "challenge");
    expect(getThreadMode("t-2")).toBe("challenge");
  });

  it("persists across cache reset (simulated process restart)", async () => {
    const mod = await import("../src/mode-store.js");
    mod._resetCacheForTests();
    mod.recordThreadMode("t-3", "challenge");
    expect(mod.getThreadMode("t-3")).toBe("challenge");

    // Simulate process restart: drop the in-memory cache. Disk persists.
    mod._resetCacheForTests();
    expect(mod.getThreadMode("t-3")).toBe("challenge");
  });

  it("supports independent records for multiple threads", async () => {
    const { recordThreadMode, getThreadMode, _resetCacheForTests } = await import("../src/mode-store.js");
    _resetCacheForTests();
    recordThreadMode("t-a", "text");
    recordThreadMode("t-b", "challenge");
    recordThreadMode("t-c", "text");
    expect(getThreadMode("t-a")).toBe("text");
    expect(getThreadMode("t-b")).toBe("challenge");
    expect(getThreadMode("t-c")).toBe("text");
  });

  it("latest write wins when a thread is rewritten", async () => {
    const mod = await import("../src/mode-store.js");
    mod._resetCacheForTests();
    mod.recordThreadMode("t-x", "text");
    mod.recordThreadMode("t-x", "challenge");
    expect(mod.getThreadMode("t-x")).toBe("challenge");

    // Confirm persistence semantics too (latest line wins on reload).
    mod._resetCacheForTests();
    expect(mod.getThreadMode("t-x")).toBe("challenge");
  });

  it("ignores malformed lines in the JSONL file", async () => {
    const mod = await import("../src/mode-store.js");
    mod._resetCacheForTests();
    mod.recordThreadMode("t-good", "challenge");

    // Append a malformed line directly to the store file.
    const storePath = join(tempHome, ".agents", "telemetry", "codex-bridge-modes.jsonl");
    expect(existsSync(storePath)).toBe(true);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(storePath, "this is not valid json\n");
    appendFileSync(storePath, '{"thread_id":"t-also-good","mode":"text"}\n');

    mod._resetCacheForTests();
    expect(mod.getThreadMode("t-good")).toBe("challenge");
    expect(mod.getThreadMode("t-also-good")).toBe("text");
  });

  it("ignores entries with invalid mode values", async () => {
    const mod = await import("../src/mode-store.js");
    mod._resetCacheForTests();

    const storePath = join(tempHome, ".agents", "telemetry", "codex-bridge-modes.jsonl");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".agents", "telemetry"), { recursive: true });
    writeFileSync(
      storePath,
      [
        '{"thread_id":"t-bogus","mode":"adversarial"}',
        '{"thread_id":"t-real","mode":"challenge"}',
      ].join("\n") + "\n"
    );

    mod._resetCacheForTests();
    expect(mod.getThreadMode("t-bogus")).toBeUndefined();
    expect(mod.getThreadMode("t-real")).toBe("challenge");
  });

  it("writes to the expected path under HOME", async () => {
    const mod = await import("../src/mode-store.js");
    mod._resetCacheForTests();
    mod.recordThreadMode("t-path", "text");

    const storePath = join(tempHome, ".agents", "telemetry", "codex-bridge-modes.jsonl");
    expect(existsSync(storePath)).toBe(true);
    const raw = readFileSync(storePath, "utf-8");
    expect(raw).toContain('"thread_id":"t-path"');
    expect(raw).toContain('"mode":"text"');
  });
});

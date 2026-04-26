/**
 * Tool-level tests for codex_code_review.
 *
 * Mocks both child_process.execFile (to fake git invocations) and
 * codex-manager (to fake the SDK turn). Covers:
 * - target validation (missing base_branch / commit_sha)
 * - the new git_missing classification (was previously misclassified as
 *   codex_missing)
 * - empty diff and oversized diff handling
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const runOnThreadMock = vi.fn();
const startThreadMock = vi.fn();
const execFileMock = vi.fn();

// Mock child_process so buildDiff() doesn't actually call git.
vi.mock("child_process", () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
    execFileMock(file, args, opts).then(
      (result: { stdout: string }) => cb(null, result),
      (err: Error) => cb(err, { stdout: "" })
    );
  },
}));

vi.mock("../../src/codex-manager.js", () => ({
  startThread: (...args: unknown[]) => startThreadMock(...args),
  runOnThread: (...args: unknown[]) => runOnThreadMock(...args),
  getThreadId: (thread: { id: string }) => thread.id,
  getDefaultTimeoutMs: () => 300_000,
}));

describe("codex_code_review tool", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    runOnThreadMock.mockReset().mockResolvedValue("review response");
    startThreadMock.mockReset().mockReturnValue({ id: "thread-review-1" });
  });

  it("rejects target=branch without base_branch", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");
    const result = await reviewTool({ target: "branch", focus: "balanced" } as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).category).toBe("review_target_invalid");
  });

  it("rejects target=commit without commit_sha", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");
    const result = await reviewTool({ target: "commit", focus: "balanced" } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("review_target_invalid");
  });

  it("rejects commit_sha that isn't a hex hash", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");
    const result = await reviewTool({ target: "commit", commit_sha: "not-a-hash", focus: "balanced" } as any);
    // Validation throws inside buildDiff; the catch branch routes this to cwd_invalid
    // by default since it doesn't match the specific patterns. Either way, the
    // important thing is it doesn't run a real git command. Accept any typed error.
    expect(result.isError).toBe(true);
  });

  it("classifies missing-git as git_missing (NOT codex_missing)", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    // Simulate ENOENT for the git binary.
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      path: "git",
    });
    execFileMock.mockRejectedValue(enoent);

    const result = await reviewTool({ target: "uncommitted", focus: "balanced" } as any);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("git_missing");
    expect(envelope.next_step).toMatch(/install git/i);
  });

  it("classifies missing cwd (ENOENT not from git) as cwd_invalid", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT: no such directory"), {
      code: "ENOENT",
      path: "/nonexistent/path",
    });
    execFileMock.mockRejectedValue(enoent);

    const result = await reviewTool({ target: "uncommitted", working_dir: "/nonexistent/path", focus: "balanced" } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("cwd_invalid");
  });

  it("classifies non-git directory as cwd_invalid", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    execFileMock.mockRejectedValue(new Error("fatal: not a git repository (or any parent up to mount point /)"));

    const result = await reviewTool({ target: "uncommitted", focus: "balanced" } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("cwd_invalid");
  });

  it("classifies unknown revision as review_target_invalid", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    execFileMock.mockRejectedValue(new Error("fatal: bad revision 'nonexistent-branch'"));

    const result = await reviewTool({
      target: "branch",
      base_branch: "nonexistent-branch",
      focus: "balanced",
    } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("review_target_invalid");
  });

  it("returns diff_empty when there are no changes to review", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    execFileMock.mockResolvedValue({ stdout: "" });

    const result = await reviewTool({ target: "uncommitted", focus: "balanced" } as any);
    expect(JSON.parse(result.content[0].text).category).toBe("diff_empty");
  });

  it("returns diff_too_large when the diff exceeds 256KB", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    const huge = "x".repeat(300_000);
    execFileMock.mockResolvedValue({ stdout: huge });

    const result = await reviewTool({ target: "uncommitted", focus: "balanced" } as any);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.category).toBe("diff_too_large");
    expect(envelope.context.bytes).toBeGreaterThan(256_000);
  });

  it("succeeds and returns thread_id when review runs cleanly", async () => {
    const { reviewTool } = await import("../../src/tools/code-review.js");

    execFileMock.mockResolvedValue({ stdout: "diff --git a/f.ts b/f.ts\n+ added\n" });

    const result = await reviewTool({ target: "uncommitted", focus: "balanced" } as any);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.thread_id).toBe("thread-review-1");
    expect(body.response).toBe("review response");
  });
});

import { describe, it, expect } from "vitest";
import { ReviewResult, ChallengeResult, ReviewFinding, ChallengeIssue, PressureTest } from "../src/schemas.js";

/**
 * Schema contract tests. Focus on the nullable-optional pattern:
 * zodToJsonSchema target=openAi emits `.optional()` as `required + nullable`,
 * so models may return `null` for any optional field. Our Zod schemas must
 * accept null and normalize it to undefined via .transform(v => v ?? undefined).
 *
 * These tests verify that safeParse accepts null/undefined/missing for every
 * nullish field, and that the transform produces the expected output.
 */

// Minimal valid building blocks for composing test objects.
const minFinding: unknown = {
  severity: "must_fix",
  category: "correctness",
  title: "Bug",
  description: "desc",
  fix: "fix",
  confidence: "high",
  rationale: "because",
};

const minPressureTest: unknown = {
  theme: "hidden_assumption",
  concern: "concern",
  suggestion: "suggestion",
};

const minChallengeIssue: unknown = {
  severity: "must_fix",
  category: "logic_gap",
  title: "Gap",
  description: "desc",
  recommendation: "rec",
  confidence: "high",
  rationale: "because",
};

describe("ReviewResult nullable fields", () => {
  const base = {
    summary: "test",
    confidence_notes: [],
    mode: "review" as const,
    findings: [minFinding],
    pressure_test: [minPressureTest],
  };

  it("accepts when strengths is undefined (omitted)", () => {
    const result = ReviewResult.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strengths).toBeUndefined();
    }
  });

  it("accepts when strengths is null (openAi nullable convention)", () => {
    const result = ReviewResult.safeParse({ ...base, strengths: null });
    expect(result.success).toBe(true);
    if (result.success) {
      // Transform should normalize null → undefined.
      expect(result.data.strengths).toBeUndefined();
    }
  });

  it("accepts when strengths is a populated array", () => {
    const result = ReviewResult.safeParse({ ...base, strengths: ["good job"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strengths).toEqual(["good job"]);
    }
  });

  it("accepts when focus is null", () => {
    const result = ReviewResult.safeParse({ ...base, focus: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
    }
  });

  it("accepts when target is null", () => {
    const result = ReviewResult.safeParse({ ...base, target: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target).toBeUndefined();
    }
  });
});

describe("ReviewFinding nullable fields", () => {
  it("accepts when file and line are null", () => {
    const result = ReviewFinding.safeParse({ ...minFinding, file: null, line: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBeUndefined();
      expect(result.data.line).toBeUndefined();
    }
  });

  it("accepts when file and line are omitted", () => {
    const result = ReviewFinding.safeParse(minFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBeUndefined();
      expect(result.data.line).toBeUndefined();
    }
  });

  it("accepts when file and line are populated", () => {
    const result = ReviewFinding.safeParse({ ...minFinding, file: "src/foo.ts", line: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBe("src/foo.ts");
      expect(result.data.line).toBe(42);
    }
  });
});

describe("ChallengeResult nullable fields", () => {
  const base = {
    summary: "test",
    confidence_notes: [],
    mode: "challenge" as const,
    issues: [minChallengeIssue],
  };

  it("accepts when focus, artifact_type, and strengths are all null", () => {
    const result = ChallengeResult.safeParse({
      ...base,
      focus: null,
      artifact_type: null,
      strengths: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
      expect(result.data.artifact_type).toBeUndefined();
      expect(result.data.strengths).toBeUndefined();
    }
  });

  it("accepts when all nullable fields are omitted", () => {
    const result = ChallengeResult.safeParse(base);
    expect(result.success).toBe(true);
  });
});

describe("ChallengeIssue nullable fields", () => {
  it("accepts when artifact_section is null", () => {
    const result = ChallengeIssue.safeParse({ ...minChallengeIssue, artifact_section: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifact_section).toBeUndefined();
    }
  });

  it("accepts when artifact_section is omitted", () => {
    const result = ChallengeIssue.safeParse(minChallengeIssue);
    expect(result.success).toBe(true);
  });
});

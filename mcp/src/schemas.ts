import { z } from "zod";

/**
 * Result schemas for structured Codex output (M3).
 *
 * These schemas are passed to `thread.run({ outputSchema })` after conversion
 * to JSON Schema (via zod-to-json-schema, target=openAi). The Codex CLI
 * constrains the model's output to the schema shape, but does NOT validate
 * the JSON server-side — `turn.finalResponse` is always a string. The bridge
 * therefore re-parses and re-validates with these same Zod schemas before
 * returning to the caller.
 *
 * IMPORTANT: `zodToJsonSchema(..., { target: "openAi" })` and nullable fields
 * ==========================================================================
 * The OpenAI structured-output convention requires ALL properties to be in
 * `required`. Zod `.optional()` is translated to `required + anyOf(type, null)`
 * — meaning the model is forced to emit the field but may emit `null` for it.
 *
 * Our Zod validation must therefore accept `null` for every field that we
 * want to be optional. The pattern used throughout these schemas:
 *
 *   `.nullable().optional().transform(v => v ?? undefined)`
 *
 * This accepts `value | null | undefined` from the model, normalizes null
 * to undefined after validation (so downstream code sees `T | undefined`),
 * and leaves the JSON schema emission (openAi target) unchanged.
 *
 * Design note on `confidence_notes`:
 *   `confidence_notes` is REVIEW-LEVEL meta-commentary about coverage gaps
 *   ("could not see test files; cannot verify regression risk", "limited
 *   visibility into auth flow"). It is distinct from per-finding `confidence`,
 *   which expresses certainty about a single finding.
 *
 * Design note on `strengths`:
 *   The system prompts instruct the model to populate `strengths` to produce
 *   balanced (not purely adversarial) output. The schema accepts null/omission
 *   so a missing presentation field cannot sink an otherwise-valid review. The
 *   bridge normalizes to `[]` post-validation. Prompt pressure, not schema
 *   pressure, drives model compliance.
 *
 * Design note on `pressure_test`:
 *   Only `review` mode carries a separate `pressure_test[]` field. The split
 *   between concrete `findings[]` (correctness/security/etc.) and
 *   `pressure_test[]` (assumption-level critique) is meaningful for code.
 *   Challenge mode does NOT have a separate pressure_test array — for non-code
 *   artifacts the distinction collapses, and the `simpler_alternative` and
 *   `scope_risk` issue categories already cover that ground in the single
 *   `issues[]` list.
 */

// ----- Nullable-optional helper -----
// See the docstring above for why this exists.

const nullish = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullable().optional().transform((v: z.infer<T> | null | undefined) => v ?? undefined);

// ----- Shared primitives -----

export const Severity = z.enum(["must_fix", "should_fix", "consider"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Focus = z.enum([
  "balanced",
  "security",
  "architecture",
  "performance",
  "challenge",
]);
export type Focus = z.infer<typeof Focus>;

const BaseResultFields = {
  summary: z
    .string()
    .describe("One-paragraph synthesis of the review or critique. Lead with the most important takeaway."),
  strengths: nullish(z.array(z.string()))
    .describe(
      "What's working well — decisions, structures, or approaches the author should KEEP as-is. Each entry is a complete affirmation sentence explaining both what is right and why. Populate even when the issues/findings list is long; silence-on-strengths produces harsh, unbalanced reviews."
    ),
  confidence_notes: z
    .array(z.string())
    .describe(
      "Review-level coverage caveats — what the model could NOT see or verify, and how that affects confidence in the result. Empty array if none. Distinct from per-finding `confidence`, which is about certainty in a single finding."
    ),
};

// ----- Review schema -----

export const ReviewFindingCategory = z.enum([
  "correctness",
  "security",
  "performance",
  "architecture",
  "regression",
  "data_integrity",
  "testing",
  "maintainability",
]);

export const ReviewFinding = z.object({
  severity: Severity,
  category: ReviewFindingCategory,
  title: z.string().describe("Short imperative title (under 80 chars)."),
  description: z.string().describe("What's wrong, in concrete terms. Quote code or behavior where useful."),
  fix: z.string().describe("Concrete suggested change. Not 'consider refactoring' — actual diff direction."),
  file: nullish(z.string()).describe("Relative file path if the finding is location-specific."),
  line: nullish(z.number().int().positive()).describe("1-indexed line number if the finding is line-specific."),
  confidence: Confidence,
  rationale: z.string().describe("Why this matters. One or two sentences."),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const PressureTestTheme = z.enum([
  "hidden_assumption",
  "over_complexity",
  "brittle_abstraction",
  "rollback_risk",
  "simpler_alternative",
  "scope_mismatch",
]);

export const PressureTest = z.object({
  theme: PressureTestTheme,
  concern: z.string().describe("The assumption or risk being pressure-tested."),
  suggestion: z.string().describe("Concrete alternative or mitigation. Not 'reconsider' — propose something."),
});
export type PressureTest = z.infer<typeof PressureTest>;

export const ReviewTarget = z.object({
  type: z.enum(["uncommitted", "branch", "commit"]),
  base_branch: nullish(z.string()),
  commit_sha: nullish(z.string()),
});
export type ReviewTarget = z.infer<typeof ReviewTarget>;

/**
 * `focus` and `target` are bridge-authored, not model-authored. They are
 * nullable/optional in the Codex output schema so the model cannot sink the
 * call by omitting them, and the bridge fills them in post-validation with
 * the values that came in on the request.
 *
 * The final result returned to callers always has both fields populated,
 * because the bridge sets them after `safeParse()` succeeds.
 */
export const ReviewResult = z.object({
  ...BaseResultFields,
  mode: z.literal("review"),
  focus: nullish(Focus),
  target: nullish(ReviewTarget),
  findings: z.array(ReviewFinding),
  pressure_test: z.array(PressureTest),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

// ----- Challenge schema -----

export const ChallengeIssueCategory = z.enum([
  "logic_gap",
  "ambiguity",
  "scope_risk",
  "ux_risk",
  "security_risk",
  "operability",
  "missing_constraint",
  "simpler_alternative",
]);

export const ChallengeIssue = z.object({
  severity: Severity,
  category: ChallengeIssueCategory,
  title: z.string().describe("Short imperative title (under 80 chars)."),
  description: z.string().describe("What's wrong with the artifact. Be specific."),
  recommendation: z.string().describe("Concrete fix or alternative. Actionable, not abstract."),
  artifact_section: nullish(z.string())
    .describe("Section heading or quoted phrase locating the issue in the artifact, if applicable."),
  confidence: Confidence,
  rationale: z.string().describe("Why this matters. One or two sentences."),
});
export type ChallengeIssue = z.infer<typeof ChallengeIssue>;

/**
 * Same focus pattern as ReviewResult: bridge-authored, nullable/optional in
 * the model output schema. Bridge fills in post-validation.
 */
export const ChallengeResult = z.object({
  ...BaseResultFields,
  mode: z.literal("challenge"),
  focus: nullish(Focus),
  artifact_type: nullish(z.string()).describe("What kind of artifact was reviewed (spec, design doc, plan, etc.)."),
  issues: z.array(ChallengeIssue),
});
export type ChallengeResult = z.infer<typeof ChallengeResult>;

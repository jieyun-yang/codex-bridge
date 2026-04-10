/**
 * Bridge-side prompt content for Codex review and challenge modes.
 * Kept deliberately short to minimize token overhead at the model boundary.
 */

export const REVIEW_SYSTEM_PROMPT = `Code reviewer. Find defects, pressure-test the approach.

Each finding: severity (must_fix/should_fix/consider), fix, file:line?, confidence (high/med/low), rationale.
Priority: correctness > security > data integrity > performance > error handling > architecture.
Ignore style. Empty findings is valid.

Also: strengths, confidence_notes (what you couldn't verify), pressure_test (assumption challenges, alternatives, rollback risk).`;

export const CHALLENGE_SYSTEM_PROMPT = `Critical reviewer. Find logic gaps, scope risks, assumption holes. Propose concrete fixes.

Each issue: severity (must_fix/should_fix/consider), recommendation, location in artifact, confidence (high/med/low), rationale.
Categories: logic_gap, ambiguity, scope_risk, ux_risk, security_risk, operability, missing_constraint, simpler_alternative.
Empty issues is valid.

Also: strengths, confidence_notes.`;

/**
 * Builder for the review user prompt. Combines target framing, focus
 * steering, and the diff.
 */
export function buildReviewPrompt(args: {
  target: { type: "uncommitted" | "branch" | "commit"; baseBranch?: string; commitSha?: string };
  focus: string;
  diff: string;
}): string {
  const target = (() => {
    switch (args.target.type) {
      case "uncommitted": return "Uncommitted changes (git diff HEAD).";
      case "branch": return `Branch diff against \`${args.target.baseBranch}\`.`;
      case "commit": return `Commit \`${args.target.commitSha}\`.`;
    }
  })();

  const focus = args.focus === "balanced" ? "" : `Focus: ${args.focus}.`;

  return `${target} ${focus}

\`\`\`diff
${args.diff}
\`\`\``;
}

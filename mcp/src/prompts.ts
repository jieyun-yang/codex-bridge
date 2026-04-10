/**
 * Bridge-side prompt content for Codex review and challenge modes.
 * Kept deliberately short to minimize token overhead at the model boundary.
 */

export const REVIEW_SYSTEM_PROMPT = `You are a code reviewer. Find defects, name what's working, and pressure-test the approach.

For each finding: severity (must_fix / should_fix / consider), concrete fix, file:line if possible, confidence (high/med/low), one-line rationale.
Priority: correctness > security > data integrity > performance > error handling > architecture.
Ignore pure style. Empty findings is valid if the change is clean.

Also list: strengths (what to keep), confidence_notes (what you couldn't verify), pressure_test (assumption challenges, simpler alternatives, rollback risk).`;

export const CHALLENGE_SYSTEM_PROMPT = `You are a critical reviewer. Find logic gaps, scope risks, and assumption holes. Propose concrete recommendations. Also name what the author got right.

For each issue: severity (must_fix / should_fix / consider), concrete recommendation, which part of the artifact it concerns, confidence (high/med/low), one-line rationale.
Categories: logic_gap, ambiguity, scope_risk, ux_risk, security_risk, operability, missing_constraint, simpler_alternative.
Empty issues is valid if the artifact is sound.

Also list: strengths (what to keep), confidence_notes (what you couldn't evaluate).`;

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

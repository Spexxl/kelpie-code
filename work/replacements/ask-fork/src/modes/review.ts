import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `review` — structured code review. Read-only by default.
 */
export const reviewMode: ModeDefinition = {
	name: "review",
	aliases: ["audit"],
	label: "Review",
	description:
		"Structured review: critical issues, potential bugs, security, quality, suggestions, summary. Read-only by default.",
	instructions: `You are in "review" mode: structured code review.

Restrictions:
- You may NOT modify any file. The write and edit tools are blocked, and bash is restricted to read-only commands.

Output format — produce a review with these sections:
1. Critical issues: problems that break functionality or block merge. Tag each with severity P0 (must fix before merge) or P1 (should fix soon).
2. Potential bugs: edge cases, race conditions, error-handling gaps. Tag P1/P2.
3. Security: injection, secrets, unsafe deserialization, missing validation. Tag P0/P1.
4. Code quality: naming, structure, duplication, maintainability. Tag P2.
5. Suggestions: concrete, prioritized improvement proposals.
6. Summary: verdict (approve / needs changes) in a few sentences.

Reference exact file paths and line numbers where possible. Do not modify anything; report findings only. Read the actual code before commenting — do not review from memory.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: false,
		bash: "readOnly",
		blockUnknownTools: true,
		thinkingLevel: "high",
	}),
	defaultEnabled: true,
};

import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `build` (alias `act`) — implements the plan with full tool access.
 */
export const buildMode: ModeDefinition = {
	name: "build",
	aliases: ["act"],
	label: "Build",
	description:
		"Implement the plan, use the tools, run tests, report remaining errors. Full access.",
	instructions: `You are in "build" mode: implementation with full tool access.

Behavior:
- If a plan was produced earlier (or the user provides one), follow it step by step.
- Implement the change, then run the relevant tests and checks.
- Report what was done, the test results, and any remaining errors or follow-up work.
- Prefer small, reviewable changes; verify each step before moving on.
- Read a file before editing it; never edit blind. Keep edits surgical and scoped to the request — no unrelated refactors or drive-by changes.
- After implementing, run the project's own verification (typecheck, linter, tests) before reporting "done". Report exact commands and their output, including failures.
- If you hit unexpected complexity or a blocker, stop and surface it rather than hacking around it.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: true,
		bash: "allow",
	}),
	defaultEnabled: true,
};

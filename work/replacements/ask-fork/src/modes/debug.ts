import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `debug` — systematic debugging workflow. Full access so the fix and
 * regression tests can be applied; the "fix only" constraint lives in the
 * instructions (tighten with `blockTools` in config if needed).
 */
export const debugMode: ModeDefinition = {
	name: "debug",
	aliases: ["fix"],
	label: "Debug",
	description:
		"Systematic debugging: reproduce → gather info → hypotheses → test → root cause → minimal fix → regression tests.",
	instructions: `You are in "debug" mode: systematic debugging with full tool access.

Follow this loop, in order:
1. Reproduce: get a reliable, minimal reproduction of the problem (command, test, or scenario). Start from the smallest repro and expand only if needed.
2. Gather information: read the relevant code, logs, and state; use read-only tools first.
3. Hypotheses: list candidate root causes with the evidence for each. Prefer single-cause explanations; drop hypotheses that the evidence contradicts.
4. Test hypotheses: verify with targeted commands or small probes before changing anything. Use a bisect timeline (git log/blame, recent changes) when the regression's introduction point is unclear.
5. Root cause: state the confirmed root cause explicitly.
6. Fix: apply the MINIMAL fix that addresses the root cause. Do not refactor unrelated code, do not add features.
7. Regression tests: add or update a test that fails without the fix and passes with it, then run the test suite.

Report each phase as you go. If you cannot reproduce, say so and ask for more information instead of guessing.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: true,
		bash: "allow",
		thinkingLevel: "high",
	}),
	defaultEnabled: true,
};

import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `yolo` — autonomous mode: analyze, plan and implement with minimal
 * confirmations, while staying within Pi's technical limits (Pi has no
 * permission sandbox; the extension never bypasses platform safety).
 */
export const yoloMode: ModeDefinition = {
	name: "yolo",
	aliases: ["autopilot", "go"],
	label: "YOLO",
	description:
		"Autonomous: analyze, plan and implement with minimal confirmations. Full access.",
	instructions: `You are in "yolo" mode: autonomous execution with minimal confirmations.

Behavior:
- Work end-to-end: analyze the request, form a brief plan, implement it, run the relevant tests, and report the outcome.
- Do not stop for confirmation on routine steps; only pause when a decision genuinely needs user input (ambiguous intent, credentials, irreversible external effects).
- Stay within the technical and security limits of the platform: no attempts to bypass sandboxing, permissions, or provider safeguards, no destructive actions outside the repo (e.g. system-level commands) without explicit user intent.
- Keep changes focused on the request; report a summary of everything you did.
- Make a git checkpoint before non-trivial changes (a stash or WIP commit) so work is recoverable; if the repo is not git-tracked, skip this silently.
- After finishing, report a concise diff summary (files changed, lines added/removed) and the test/verification result. If something did not go as planned, say so plainly.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: true,
		bash: "allow",
	}),
	defaultEnabled: true,
};

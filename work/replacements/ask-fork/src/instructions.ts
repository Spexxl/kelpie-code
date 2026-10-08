import type { EffectiveMode } from "./types.ts";

/**
 * System-prompt section injected per turn while a mode is active, via the
 * `before_agent_start` hook (`systemPrompt` chaining — verified in
 * extensions.md). Per-turn injection needs no session cleanup, unlike
 * message-based injection.
 */

/** Marker line at the start of the section. */
export function modeHeader(mode: EffectiveMode): string {
	const lock = mode.policy.allowWriteTools ? "" : " 🔒 read-only";
	return `[ACTIVE MODE: ${mode.name.toUpperCase()}${lock}]`;
}

/** One-line summary of the mode's tool restrictions. */
export function policySummary(mode: EffectiveMode): string {
	const parts: string[] = [];
	if (!mode.policy.allowWriteTools) parts.push("write/edit tools blocked");
	if (mode.policy.bash === "readOnly") parts.push("bash restricted to read-only commands");
	if (mode.policy.bash === "deny") parts.push("bash disabled");
	for (const tool of mode.policy.blockTools) parts.push(`"${tool}" blocked`);
	if (mode.policy.blockUnknownTools) parts.push("unknown tools blocked");
	if (parts.length === 0) return "full tool access";
	return parts.join("; ");
}

/** Assemble the full section appended to the system prompt. */
export function buildModePromptSection(mode: EffectiveMode): string {
	return [
		"",
		modeHeader(mode),
		`Mode "${mode.name}" (${mode.label}). Tool policy: ${policySummary(mode)}.`,
		"",
		mode.instructions,
	].join("\n");
}

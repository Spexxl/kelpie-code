import type { EffectiveMode } from "./types.ts";

/**
 * Status-bar rendering for the active mode (`ctx.ui.setStatus`).
 * The theme object is passed in by the caller (`ctx.ui.theme`), keeping this
 * module pure.
 */

export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** Color per mode, aligned with the pi theme palette. */
export const MODE_COLORS: Record<string, string> = {
	ask: "muted",
	plan: "warning",
	build: "success",
	review: "accent",
	debug: "warning",
	yolo: "error",
};

export function modeColor(mode: EffectiveMode): string {
	return MODE_COLORS[mode.name] ?? "accent";
}

/** Persistent footer text, e.g. `Ⓜ plan 🔒`. */
export function modeStatusText(mode: EffectiveMode, theme: ThemeLike): string {
	const lock = mode.policy.allowWriteTools ? "" : " 🔒";
	return theme.fg(modeColor(mode), `Ⓜ ${mode.name}${lock}`);
}

/** Short mode-switch notification, e.g. `mode: build ~ full access.` */
export function modeNotificationText(mode: EffectiveMode): string {
	const access = mode.policy.allowWriteTools
		? mode.policy.bash === "allow"
			? "full access"
			: "writes allowed, restricted bash"
		: "read-only";
	return `mode: ${mode.name} ~ ${access}.`;
}

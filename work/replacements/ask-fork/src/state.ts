import type { ModeState, PersistedPlanStep } from "./types.ts";

/**
 * Session persistence for the active mode.
 *
 * State is stored as a custom session entry via `pi.appendEntry("pi-modes", ...)`
 * and restored on `session_start` from the current branch (`getBranch()`), so
 * forks and tree navigation get the correct state for their branch. Restoring
 * from the *last* entry on the branch handles repeated switches.
 *
 * Pure functions — the actual `pi.appendEntry` call lives in the extension
 * entry point.
 */

/** `customType` used for the persisted mode state entry. */
export const MODE_STATE_ENTRY_TYPE = "pi-modes";

/** Shape of a session entry as seen by extensions. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Build the state object persisted on mode changes and plan progress updates. */
export function buildStateEntry(mode: string, previousMode: string | undefined, changedAt?: number): ModeState;
export function buildStateEntry(
	mode: string,
	previousMode: string | undefined,
	planSteps?: readonly PersistedPlanStep[],
	planExecuting?: boolean,
	planMarkdown?: string,
	changedAt?: number,
): ModeState;
export function buildStateEntry(
	mode: string,
	previousMode: string | undefined,
	third?: number | readonly PersistedPlanStep[],
	planExecuting = false,
	planMarkdown?: string,
	changedAt = Date.now(),
): ModeState {
	const planSteps = typeof third === "number" || third === undefined ? [] : third;
	const effectiveChangedAt = typeof third === "number" ? third : changedAt;
	return {
		version: 2,
		mode,
		previousMode,
		changedAt: effectiveChangedAt,
		...(planSteps.length > 0 ? { planSteps: planSteps.map((step) => ({ ...step })) } : {}),
		...(planExecuting ? { planExecuting: true } : {}),
		...(typeof planMarkdown === "string" && planMarkdown.trim().length > 0 ? { planMarkdown } : {}),
	};
}

/**
 * Extract the persisted mode state from session entries.
 * @returns the last `pi-modes` entry on the given branch, or `undefined`.
 */
export function extractState(entries: readonly SessionEntryLike[]): ModeState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const state = data as Partial<ModeState>;
			if (typeof state.mode === "string" && state.mode.length > 0) {
				const planSteps = Array.isArray(state.planSteps)
					? state.planSteps.flatMap((step) => {
						if (
							typeof step !== "object" ||
							step === null ||
							typeof step.step !== "number" ||
							!Number.isInteger(step.step) ||
							step.step < 1 ||
							typeof step.text !== "string" ||
							typeof step.completed !== "boolean"
						) {
							return [];
						}
						return [{ step: step.step, text: step.text, completed: step.completed }];
					})
					: [];
				return {
					version: 2,
					mode: state.mode,
					previousMode: typeof state.previousMode === "string" ? state.previousMode : undefined,
					changedAt: typeof state.changedAt === "number" ? state.changedAt : 0,
					...(planSteps.length > 0 ? { planSteps } : {}),
					...(state.planExecuting === true ? { planExecuting: true } : {}),
					...(typeof state.planMarkdown === "string" && state.planMarkdown.trim().length > 0
						? { planMarkdown: state.planMarkdown }
						: {}),
				};
			}
		}
	}
	return undefined;
}

/** Compute the previous-mode pointer after switching to `newMode`. */
export function nextPrevious(current: string | undefined, newMode: string): string | undefined {
	if (current === undefined || current === newMode) return undefined;
	return current;
}

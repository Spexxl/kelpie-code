/**
 * Pure plan-step extraction and progress tracking.
 *
 * Adapted from pi's example `plan-mode/utils.ts`, kept dependency-free so it is
 * fully unit-testable. The runtime hooks in `extensions/index.ts` call these
 * functions to drive the plan-mode progress widget and the `[DONE:n]` markers.
 */

/** One numbered step extracted from a "Plan:" section. */
export interface PlanStep {
	/** 1-based step number, as written by the model. */
	step: number;
	/** Cleaned, human-readable step text. */
	text: string;
	/** Whether the model has marked this step complete via `[DONE:n]`. */
	completed: boolean;
}

/** Strip markdown emphasis and normalize a step line for display. */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // bold/italic
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

/**
 * Extract numbered plan steps from an assistant message that contains a
 * "Plan:" section. Returns `[]` when no plan header is present.
 */
export function extractPlanSteps(message: string): PlanStep[] {
	const items: PlanStep[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch || headerMatch.index === undefined) return items;

	const planSection = message.slice(headerMatch.index + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = match[2]?.trim().replace(/\*{1,2}$/, "").trim() ?? "";
		// Skip code blocks, sub-bullets, and trivially short fragments.
		if (raw.length <= 5 || raw.startsWith("`") || raw.startsWith("/") || raw.startsWith("-")) continue;
		const cleaned = cleanStepText(raw);
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

/** Extract the step numbers the model marked done via `[DONE:n]`. */
export function extractDoneMarkers(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/**
 * Mark steps complete based on `[DONE:n]` markers found in `text`.
 * Mutates `steps` in place; returns the count of newly completed steps.
 */
export function markCompletedSteps(text: string, steps: PlanStep[]): number {
	const done = extractDoneMarkers(text);
	let newlyDone = 0;
	for (const step of done) {
		const item = steps.find((s) => s.step === step);
		if (item && !item.completed) {
			item.completed = true;
			newlyDone++;
		}
	}
	return newlyDone;
}

/** Number of completed steps. */
export function completedCount(steps: readonly PlanStep[]): number {
	return steps.filter((s) => s.completed).length;
}

/** Render the progress widget lines using theme colors via the given styler. */
export function renderStepLines(
	steps: readonly PlanStep[],
	fg: (color: string, text: string) => string,
): string[] {
	return steps.map((item) => {
		if (item.completed) {
			return fg("success", "☑ ") + fg("muted", item.text);
		}
		return `${fg("muted", "☐ ")}${item.text}`;
	});
}

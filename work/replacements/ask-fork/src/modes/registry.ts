import type { ModeDefinition } from "../types.ts";
import { askMode } from "./ask.ts";
import { buildMode } from "./build.ts";
import { debugMode } from "./debug.ts";
import { planMode } from "./plan.ts";
import { reviewMode } from "./review.ts";
import { yoloMode } from "./yolo.ts";

/** All built-in modes, in display order. */
export const BUILTIN_MODES: readonly ModeDefinition[] = [
	askMode,
	planMode,
	buildMode,
	reviewMode,
	debugMode,
	yoloMode,
];

/**
 * Central registry for modes. Each mode is a plain `ModeDefinition`; no mode
 * logic is hardcoded in the extension entry point.
 */
export class ModeRegistry {
	private readonly byName = new Map<string, ModeDefinition>();

	constructor(modes: readonly ModeDefinition[] = BUILTIN_MODES) {
		for (const mode of modes) this.register(mode);
	}

	/** Register a mode; its canonical name and all aliases become resolvable. */
	register(mode: ModeDefinition): void {
		if (this.byName.has(mode.name)) {
			throw new Error(`Mode already registered: ${mode.name}`);
		}
		this.byName.set(mode.name, mode);
		for (const alias of mode.aliases) {
			if (this.byName.has(alias)) {
				throw new Error(`Alias already in use: ${alias}`);
			}
			this.byName.set(alias, mode);
		}
	}

	/**
	 * Resolve a name or alias to a mode.
	 * @returns the mode, or `undefined` when unknown.
	 */
	resolve(name: string): ModeDefinition | undefined {
		return this.byName.get(name.trim().toLowerCase());
	}

	/** The canonical name for a name/alias, or `undefined` when unknown. */
	canonicalName(name: string): string | undefined {
		return this.resolve(name)?.name;
	}

	/** All unique modes in registration order (canonical names only). */
	list(): ModeDefinition[] {
		const seen = new Set<string>();
		const result: ModeDefinition[] = [];
		for (const mode of this.byName.values()) {
			if (!seen.has(mode.name)) {
				seen.add(mode.name);
				result.push(mode);
			}
		}
		return result;
	}
}

/**
 * The next mode when cycling, `direction` 1 = forward, -1 = backward.
 * Input must contain enabled modes only (disabled modes are not switchable).
 * Returns `undefined` when there is nothing to cycle between (< 2 modes) or
 * when the current mode is not part of the list.
 */
export function cycleMode(
	modeNames: readonly string[],
	currentName: string,
	direction: 1 | -1,
): string | undefined {
	if (modeNames.length < 2) return undefined;
	const index = modeNames.indexOf(currentName);
	if (index === -1) return undefined;
	return modeNames[(index + direction + modeNames.length) % modeNames.length];
}

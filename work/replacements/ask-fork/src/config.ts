import type { ModesConfig, ModeConfigOverride, ModeDefinition, EffectiveMode, ModePolicy, ThinkingLevel } from "./types.ts";
import type { ModeRegistry } from "./modes/registry.ts";

/** Config file name inside the pi config dir / project `.pi` dir. */
export const CONFIG_FILE_NAME = "modes.config.json";

/** Invalid bash policy values are rejected here. */
const BASH_POLICIES = new Set(["allow", "readOnly", "deny"]);

/** Valid thinking levels a config may force. `null` clears a mode default. */
const THINKING_LEVELS = new Set<ThinkingLevel | null>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	null,
]);

export interface ConfigValidationIssue {
	path: string;
	message: string;
}

export interface LoadedConfig {
	config: ModesConfig;
	issues: ConfigValidationIssue[];
}

/** Parse + validate a raw JSON string. Returns issues instead of throwing. */
export function parseModesConfig(raw: string, source: string): LoadedConfig {
	const issues: ConfigValidationIssue[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			config: {},
			issues: [{ path: source, message: `Invalid JSON: ${(error as Error).message}` }],
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			config: {},
			issues: [{ path: source, message: "Config root must be a JSON object." }],
		};
	}
	const config = parsed as ModesConfig;
	if (config.defaultMode !== undefined && typeof config.defaultMode !== "string") {
		issues.push({ path: `${source}.defaultMode`, message: "defaultMode must be a string." });
		config.defaultMode = undefined;
	}
	if (config.modes !== undefined) {
		if (typeof config.modes !== "object" || Array.isArray(config.modes)) {
			issues.push({ path: `${source}.modes`, message: "modes must be an object keyed by mode name." });
			config.modes = undefined;
		} else {
			for (const [name, override] of Object.entries(config.modes)) {
				validateOverride(name, override, source, issues);
			}
		}
	}
	return { config, issues };
}

function validateOverride(name: string, override: ModeConfigOverride, source: string, issues: ConfigValidationIssue[]): void {
	const path = `${source}.modes.${name}`;
	if (override === null || typeof override !== "object" || Array.isArray(override)) {
		issues.push({ path, message: "Mode override must be an object." });
		return;
	}
	if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
		issues.push({ path: `${path}.enabled`, message: "enabled must be a boolean." });
		delete override.enabled;
	}
	if (override.description !== undefined && typeof override.description !== "string") {
		issues.push({ path: `${path}.description`, message: "description must be a string." });
		delete override.description;
	}
	if (override.instructions !== undefined && typeof override.instructions !== "string") {
		issues.push({ path: `${path}.instructions`, message: "instructions must be a string." });
		delete override.instructions;
	}
	if (
		override.extraInstructions !== undefined &&
		(typeof override.extraInstructions !== "string" &&
			(!Array.isArray(override.extraInstructions) || override.extraInstructions.some((i) => typeof i !== "string")))
	) {
		issues.push({ path: `${path}.extraInstructions`, message: "extraInstructions must be a string or an array of strings." });
		delete override.extraInstructions;
	}
	if (override.allowWriteTools !== undefined && typeof override.allowWriteTools !== "boolean") {
		issues.push({ path: `${path}.allowWriteTools`, message: "allowWriteTools must be a boolean." });
		delete override.allowWriteTools;
	}
	if (override.bash !== undefined && !BASH_POLICIES.has(override.bash)) {
		issues.push({ path: `${path}.bash`, message: `bash must be one of: allow, readOnly, deny (got "${String(override.bash)}").` });
		delete override.bash;
	}
	for (const key of ["blockTools", "allowTools"] as const) {
		const value = override[key];
		if (value !== undefined && (!Array.isArray(value) || value.some((t) => typeof t !== "string"))) {
			issues.push({ path: `${path}.${key}`, message: `${key} must be an array of tool names.` });
			delete override[key];
		}
	}
	if (override.blockUnknownTools !== undefined && typeof override.blockUnknownTools !== "boolean") {
		issues.push({ path: `${path}.blockUnknownTools`, message: "blockUnknownTools must be a boolean." });
		delete override.blockUnknownTools;
	}
	if (override.thinkingLevel !== undefined && !THINKING_LEVELS.has(override.thinkingLevel)) {
		issues.push({
			path: `${path}.thinkingLevel`,
			message: `thinkingLevel must be one of: off, minimal, low, medium, high, xhigh, max (or null to clear); got ${JSON.stringify(override.thinkingLevel)}.`,
		});
		delete override.thinkingLevel;
	}
}

/** Apply a config override on top of a mode definition. */
export function applyOverride(mode: ModeDefinition, override: ModeConfigOverride | undefined): EffectiveMode {
	const policy: ModePolicy = {
		allowWriteTools: override?.allowWriteTools ?? mode.defaultPolicy.allowWriteTools,
		bash: override?.bash ?? mode.defaultPolicy.bash,
		blockTools: override?.blockTools ?? mode.defaultPolicy.blockTools,
		allowTools: override?.allowTools ?? mode.defaultPolicy.allowTools,
		blockUnknownTools: override?.blockUnknownTools ?? mode.defaultPolicy.blockUnknownTools,
		// `null` explicitly clears a mode default; `undefined` falls back to it.
		thinkingLevel: override?.thinkingLevel !== undefined ? (override.thinkingLevel ?? undefined) : mode.defaultPolicy.thinkingLevel,
	};
	const baseInstructions = override?.instructions ?? mode.instructions;
	const extraValue = override?.extraInstructions;
	const extra = extraValue === undefined ? [] : typeof extraValue === "string" ? [extraValue] : extraValue;
	const instructions =
		extra.length > 0 ? `${baseInstructions}\n\n${extra.join("\n")}` : baseInstructions;
	return {
		...mode,
		enabled: override?.enabled ?? mode.defaultEnabled,
		description: override?.description ?? mode.description,
		instructions,
		policy,
	};
}

/**
 * Compute effective modes for the whole registry.
 * Unknown mode names in the config are reported as issues and ignored.
 */
export function resolveEffectiveModes(registry: ModeRegistry, config: ModesConfig, issues: ConfigValidationIssue[] = []): Map<string, EffectiveMode> {
	const result = new Map<string, EffectiveMode>();
	for (const mode of registry.list()) {
		const override = config.modes?.[mode.name];
		if (override !== undefined && override.enabled === false) {
			// Kept out of the map entirely: disabled modes are not switchable.
			continue;
		}
		result.set(mode.name, applyOverride(mode, override));
	}
	for (const name of Object.keys(config.modes ?? {})) {
		if (!registry.resolve(name)) {
			issues.push({ path: `modes.${name}`, message: `Unknown mode "${name}" in config; ignored.` });
		}
	}
	return result;
}

/**
 * Pick the initial mode, in priority order:
 * 1. `--modes` CLI flag (if it resolves to an enabled mode)
 * 2. persisted session state (if it resolves to an enabled mode)
 * 3. `defaultMode` from config (if it resolves to an enabled mode)
 * 4. the first enabled mode in registration order
 *
 * Invalid candidates are reported as issues and skipped, never fatal.
 */
export function pickInitialMode(
	effective: Map<string, EffectiveMode>,
	cliMode: string | undefined,
	persisted: string | undefined,
	defaultMode: string | undefined,
	issues: ConfigValidationIssue[],
	canonicalize: (name: string) => string | undefined = (name) => name.trim().toLowerCase(),
): EffectiveMode | undefined {
	const candidates: Array<{ value: string | undefined; label: string }> = [
		{ value: cliMode, label: "CLI flag --modes" },
		{ value: persisted, label: "persisted session state" },
		{ value: defaultMode, label: "config defaultMode" },
	];
	for (const candidate of candidates) {
		if (candidate.value) {
			const canonical = canonicalize(candidate.value);
			const mode = canonical ? effective.get(canonical) : undefined;
			if (mode) return mode;
			issues.push({ path: "state", message: `Unknown or disabled mode "${candidate.value}" (${candidate.label}); falling back to default.` });
		}
	}
	return [...effective.values()][0];
}

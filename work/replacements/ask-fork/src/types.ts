/**
 * Core types for the pi-agent-modes extension.
 *
 * These types are deliberately free of any Pi runtime dependency so the
 * modules that consume them (registry, guard, config, state) stay pure and
 * unit-testable.
 */

/** How the `bash` tool is treated by a mode. */
export type BashPolicy = "allow" | "readOnly" | "deny";

/**
 * Reasoning/thinking level a mode can force via `pi.setThinkingLevel()`.
 * `undefined` (the default) leaves the current level untouched.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Tool-level policy of a mode. This is the only layer that can *technically*
 * enforce read-only behavior: Pi has no native permission system, so blocking
 * happens in the `tool_call` hook (and by removing tools from the active set).
 */
export interface ModePolicy {
  /** Allow the built-in `edit` and `write` tools. */
  allowWriteTools: boolean;
  /** Bash policy: allow everything, allow only read-only commands, or deny. */
  bash: BashPolicy;
  /** Tools that are always blocked in this mode (e.g. custom mutating tools). */
  blockTools: string[];
  /** Tools that are always allowed, even if the policy would block them. */
  allowTools: string[];
  /**
   * Block tools that are neither built-in read-only tools nor listed in
   * `allowTools`. Custom extension tools may mutate files in ways we cannot
   * introspect; enable this for strict read-only guarantees.
   */
  blockUnknownTools: boolean;
  /**
   * Optional reasoning level forced while this mode is active (via
   * `pi.setThinkingLevel()`). `undefined` leaves the current level untouched,
   * so working modes do not override user-chosen levels by default.
   */
  thinkingLevel?: ThinkingLevel;
}

/**
 * A mode as registered in the central registry. Each mode lives in its own
 * module under `src/modes/` and is a plain data object.
 */
export interface ModeDefinition {
  /** Canonical name, used with `/mode <name>`. */
  name: string;
  /** Alternative names that resolve to this mode (e.g. `act` for `build`). */
  aliases: string[];
  /** Short display label. */
  label: string;
  /** Default description shown by `/mode`. */
  description: string;
  /** Default system-prompt section injected while the mode is active. */
  instructions: string;
  /** Default tool policy. */
  defaultPolicy: ModePolicy;
  /** Whether the mode is available without explicit configuration. */
  defaultEnabled: boolean;
}

/** Per-mode overrides from a config file. All fields optional. */
export interface ModeConfigOverride {
  enabled?: boolean;
  description?: string;
  /** Replaces the default `instructions` entirely when set. */
  instructions?: string;
  /** Appended to the effective instructions; accepts one string or an array. */
  extraInstructions?: string | string[];
  allowWriteTools?: boolean;
  bash?: BashPolicy;
  blockTools?: string[];
  allowTools?: string[];
  blockUnknownTools?: boolean;
  /** Override the mode's forced thinking level (or `null` to clear it). */
  thinkingLevel?: ThinkingLevel | null;
}

/** Root shape of `modes.config.json`. */
export interface ModesConfig {
  /** Mode active when a session has no persisted state. */
  defaultMode?: string;
  /** Per-mode overrides keyed by canonical mode name. */
  modes?: Record<string, ModeConfigOverride>;
}

/** A mode with its config overrides applied — what the runtime actually uses. */
export interface EffectiveMode extends ModeDefinition {
  enabled: boolean;
  description: string;
  instructions: string;
  policy: ModePolicy;
}

/** A persisted plan step, kept dependency-free for session restoration. */
export interface PersistedPlanStep {
  step: number;
  text: string;
  completed: boolean;
}

/** Persisted per-session mode state (stored via `pi.appendEntry`). */
export interface ModeState {
  version: 2;
  mode: string;
  previousMode?: string;
  changedAt: number;
  planSteps?: PersistedPlanStep[];
  planExecuting?: boolean;
  planMarkdown?: string;
}

/** Default policy factory. */
export function defaultPolicy(partial?: Partial<ModePolicy>): ModePolicy {
  return {
    allowWriteTools: true,
    bash: "allow",
    blockTools: [],
    allowTools: [],
    blockUnknownTools: false,
    ...partial,
  };
}

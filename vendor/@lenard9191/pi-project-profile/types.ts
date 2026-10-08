/**
 * Shared types for the project-profile extension.
 *
 * Everything in DetectedProfile must be JSON-serialisable and deterministic
 * (sorted, no timestamps) so the cache file and the injected prompt section are
 * stable across sessions (stable prompt = prompt-cache hits).
 */

/** argv[0] prefix meaning "resolve node_modules/.bin/<tool> at run time, walking up from cwd". */
export const NODE_BIN_PREFIX = "node_modules/.bin:";
/** argv[0] prefix "python:<manager>:<tool>" resolved at run time (runner → venv → PATH). */
export const PY_PREFIX = "python:";

/** Check tiers, in execution order. */
export type Tier = "syntax" | "fast" | "lint" | "test" | "build";

/** What a tier is allowed to do without asking. */
export const TIER_POLICY: Record<Tier, "auto" | "confirm"> = {
  syntax: "auto", // per-file parse checks, no side effects
  fast: "auto", // read-only type/compile checks (tsc --noEmit, cargo check, go vet, mypy…)
  lint: "auto", // read-only linters / format --check
  test: "confirm", // may hit databases, network, ports; confirmed once per repo
  build: "confirm", // writes artifacts, may download dependencies; confirmed once per repo
};

export interface CheckRequirement {
  /** Executable that must resolve on PATH (or absolute path that must exist). */
  bin?: string;
  /** Files (relative to check cwd) that must exist, e.g. node_modules. */
  files?: string[];
  /** Human hint shown when the requirement is missing. */
  hint?: string;
}

/**
 * How to narrow a check to the changed files (test tier). The full command
 * stays the fallback whenever narrowing is not safe (config/manifest changed,
 * unknown file kinds, virtual workspace root, …).
 */
export interface ScopeSpec {
  kind: "vitest" | "jest" | "go" | "cargo" | "cargo-check" | "pytest";
  /** argv prefix of the scoped form (late-bound head allowed); changed files are appended. Defaults derive from the check's own argv. */
  argv?: string[];
  /** Display prefix of the scoped form. */
  cmd?: string;
}

/** Session-wide identity of a check: the id is unique per project dir, so the dir is part of the key. */
export function checkKey(c: Pick<Check, "id" | "cwd">): string {
  return `${c.id}@${c.cwd}`;
}

export interface Check {
  /** Stable id, e.g. "node:typecheck", "cargo:check". Unique per project dir. */
  id: string;
  tier: Tier;
  /** Short label: typecheck | lint | test | build | format | syntax */
  label: string;
  /** Display string (what a human would type). */
  cmd: string;
  /** argv to execute (no shell) unless viaShell is set. */
  argv: string[];
  /** Run through `sh -c` (CI-derived commands). */
  viaShell?: boolean;
  /** Absolute directory to execute in. */
  cwd: string;
  /** Why this check exists. */
  source: string;
  /** Only run when a changed file has one of these extensions (lowercase, with dot). Empty = any source change. */
  exts?: string[];
  /** Append matching changed file paths (relative to cwd) to argv. */
  appendFiles?: boolean;
  /** For appendFiles checks run without a file list (manual /verify, run_checks): args to use instead, e.g. ["."] or []. Undefined = skip. */
  unscopedArgs?: string[];
  /** Treat non-empty stdout as failure even with exit 0 (gofmt -l, cargo fmt --check style tools). */
  failOnOutput?: boolean;
  /** Narrow the run to the changed files when possible (see verify/scope.ts). */
  scope?: ScopeSpec;
  /** Narrow, PATH-detected linter for one file type (shellcheck, hadolint): never counts as the project's own lint/typecheck when choosing CI or task-runner checks. */
  incidental?: boolean;
  /** Runs across the whole workspace (turbo/nx/pnpm -r/tsc -b …): package-level checks with the same label are redundant when this runs. */
  coversWorkspace?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  requires?: CheckRequirement;
  /** Tool family for output pruning heuristics. */
  tool?: string;
}

export interface CommandInfo {
  cmd: string;
  source: string;
}

export interface InstructionFile {
  path: string; // relative to root
  bytes: number;
  /** Pi loads AGENTS.md / CLAUDE.md natively. */
  loadedByPi: boolean;
  /** Included inline in the prompt section when small enough. */
  content?: string;
}

export interface DetectedProfile {
  /** Detector version; bump to invalidate caches. */
  version: number;
  root: string;
  name?: string;
  gitRoot?: string;
  remote?: string;
  trackedFiles?: number;
  languages: string[];
  /** Human-readable stack tokens (frameworks, tools, versions). */
  stack: string[];
  runtimes: Record<string, string>;
  /** Package manager / task runner command prefix, e.g. "pnpm", "cargo". */
  commands: Record<string, CommandInfo>;
  checks: Check[];
  instructionFiles: InstructionFile[];
  ci?: { provider: string; files: string[]; runs: string[] };
  conventions: string[];
  layout: string[];
  services: string[];
  notes: string[];
  /** `dirs`: the nested projects of an umbrella repo without a manifest at its root (relative to root). */
  monorepo?: { kind: string; packages?: number; tool?: string; dirs?: string[] };
  /** Test naming/location conventions from the tracked files. */
  tests?: string;
  /** `.gitattributes` linguist-generated patterns (hand edits are overwritten). */
  generated?: string[];
  /** file → "mtime:size" for cache invalidation. */
  fingerprint: Record<string, string>;
}

export interface UserData {
  /** command key → command string, or null to disable. */
  overrides: Record<string, string | null>;
  notes: string[];
  permissions: { tests?: "allow" | "deny"; build?: "allow" | "deny" };
  /** Per-repo verify switch (undefined = global default). */
  verify?: boolean;
}

export interface StoredProfile {
  detected: DetectedProfile;
  user: UserData;
  updatedAt: string;
}

export interface ProfileConfig {
  verify: {
    enabled: boolean;
    maxRepairRounds: number;
    fastTimeoutMs: number;
    testTimeoutMs: number;
    buildTimeoutMs: number;
    /** Default answer for test/build tiers when not yet decided for a repo. */
    runTests: "ask" | "allow" | "deny";
    runBuild: "ask" | "allow" | "deny";
    /** Run the gate in print/json/rpc modes (subagents, headless). */
    headless: boolean;
    /** Max diagnostic lines sent to the model per failure. */
    maxOutputLines: number;
    /** After the last failed repair round, ask the agent for a short summary (one extra model call) instead of stopping silently. */
    summarizeOnGiveUp: boolean;
    /**
     * Also run the syntax + fast tiers after every turn that wrote files (tool writes only), and append a
     * non-continuing note when red. Off by default: it adds the check's latency to each such turn, and
     * multi-file edits are legitimately red half-way through.
     */
    perTurn: boolean;
    /** Review the task's changes for added suppressions/skips/stubs, deleted tests, loosened configs, secrets, unignored .env files and stale lockfiles. */
    guard: boolean;
    /** Checks run concurrently within the syntax/fast/lint tiers (0 = auto: half the cores, max 4). Tests and builds always run one at a time. */
    concurrency: number;
  };
  profile: {
    inject: boolean;
    maxInstructionFileChars: number;
    maxInstructionTotalChars: number;
    /** Include instruction-file contents inline (else list only). */
    inlineInstructionFiles: boolean;
    /** Deliver nested AGENTS.md/CLAUDE.md and glob-scoped rules (.cursor/rules, .github/instructions, .windsurf/rules) when the agent first touches a file they apply to. */
    scopedInstructions: boolean;
  };
  ignoreDirs: string[];
}

export const DEFAULT_CONFIG: ProfileConfig = {
  verify: {
    enabled: true,
    maxRepairRounds: 3,
    fastTimeoutMs: 180_000,
    testTimeoutMs: 600_000,
    buildTimeoutMs: 600_000,
    runTests: "ask",
    runBuild: "ask",
    headless: true,
    maxOutputLines: 40,
    summarizeOnGiveUp: true,
    perTurn: false,
    guard: true,
    concurrency: 0,
  },
  profile: {
    inject: true,
    maxInstructionFileChars: 3000,
    maxInstructionTotalChars: 6000,
    inlineInstructionFiles: true,
    scopedInstructions: true,
  },
  ignoreDirs: [
    ".git",
    "node_modules",
    ".pnpm",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
    ".gradle",
    ".dart_tool",
    "Pods",
    "DerivedData",
    ".zig-cache",
    "zig-out",
    "_build",
    "deps",
    "bin",
    "obj",
  ],
};

/** Result of running one check. */
export interface CheckRun {
  check: Check;
  /** preexisting = failed, but only with failures recorded before this task (not sent to the agent). */
  status: "pass" | "fail" | "env" | "skipped" | "preexisting";
  exitCode: number | null;
  durationMs: number;
  /** Pruned, model-facing lines. */
  summary: string[];
  /** Total output lines before pruning. */
  totalLines: number;
  /** Path to the full log, when written. */
  logPath?: string;
  reason?: string;
  timedOut?: boolean;
  /** Diagnostics hidden because they existed before this task. */
  preexisting?: number;
  /** Normalised diagnostic multiset of this run (baseline bookkeeping; project-wide checks only). */
  diag?: Map<string, number>;
  /** The run was narrowed to the changed files (not a full-baseline run). */
  scoped?: boolean;
  /** Files the check ran on (per-file checks), relative to its cwd. */
  files?: string[];
}

export interface GateVerdict {
  status: "green" | "red" | "env" | "skipped";
  runs: CheckRun[];
  changedFiles: string[];
  /** Hash of the failing output — used to detect "no progress". */
  signature?: string;
  durationMs: number;
}

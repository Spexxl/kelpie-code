/**
 * Diff guard: what did this task add that a reviewer would want to know?
 *
 * A verification loop gives the agent an incentive to make checks pass the
 * wrong way (suppress, skip, delete, loosen). The harness sees every change,
 * so it can say so. Also: secrets written into files, .env files that would
 * be committed, and dependency changes without a lockfile update (CI with a
 * frozen lockfile fails on those).
 *
 * Attribution is conservative: "before" is the content captured just before
 * the agent's first write to a file, or git HEAD for files that were clean
 * when the prompt started. Files that were already dirty and then changed by
 * a shell command are never attributed to the agent.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export type FindingKind = "secret" | "env-file" | "lockfile" | "focus" | "suppression" | "skip" | "stub" | "loosen" | "deleted-test" | "removed-tests";

export interface Finding {
  kind: FindingKind;
  /** Display path ("/"-separated, relative to the project or git root). */
  file: string;
  lines: number[];
  /** What was found. Never contains a secret value. */
  what: string;
  /** Short snippet of the added code (not set for secrets). */
  sample?: string;
  /** Command that fixes it, when there is one. */
  fix?: string;
  key: string;
}

/** Content that exists but cannot be analysed (binary, too large, unknown history). */
export const SKIP = "\u0000skip";
export type Before = string | null; // null = did not exist; SKIP = unknown

export function readForDiff(p: string): Before {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > 1_000_000) return SKIP;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) return SKIP;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** Content of a path at HEAD, null when it is not in HEAD, SKIP when git cannot tell. */
export function headContent(gitRoot: string, rel: string): Before {
  const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: gitRoot, encoding: "utf8", maxBuffer: 2_000_000, timeout: 10_000 });
  if (r.status === 0) return r.stdout.includes("\u0000") ? SKIP : r.stdout;
  if (r.status === 128 && /exists on disk, but not in|does not exist in|bad revision|invalid object name/i.test(r.stderr)) return null;
  return SKIP;
}

/** Lines of `after` beyond what `before` already had (multiset diff: moved lines are not "added"). */
export function addedLines(before: string, after: string): Array<{ line: number; text: string }> {
  const counts = new Map<string, number>();
  for (const l of before.split("\n")) {
    const k = l.trimEnd();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: Array<{ line: number; text: string }> = [];
  after.split("\n").forEach((l, i) => {
    const k = l.trimEnd();
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else if (k.trim()) out.push({ line: i + 1, text: k });
  });
  return out;
}

interface Pat {
  kind: FindingKind;
  re: RegExp;
  what: string;
}

const JS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro)$/i;

const CODE_PATTERNS: Array<[RegExp, Pat[]]> = [
  [
    JS,
    [
      { kind: "suppression", re: /@ts-(ignore|nocheck|expect-error)\b/, what: "TypeScript error suppressed" },
      { kind: "suppression", re: /\b(eslint|oxlint)-disable/, what: "lint rule disabled inline" },
      { kind: "suppression", re: /\bbiome-ignore\b/, what: "Biome rule ignored inline" },
      { kind: "suppression", re: /\b(istanbul|c8|v8) ignore\b/, what: "code excluded from coverage" },
      { kind: "focus", re: /\b(it|test|describe|suite|context)\.only\s*\(|\b(fit|fdescribe)\s*\(/, what: "focused test (.only): the rest of the suite stops running" },
      { kind: "skip", re: /\b(it|test|describe|suite|context)\.(skip|todo)\s*\(|\b(xit|xtest|xdescribe)\s*\(/, what: "test skipped" },
      { kind: "stub", re: /throw new Error\(\s*['"`](not implemented|unimplemented|todo)\b/i, what: "stub left in (throws 'not implemented')" },
    ],
  ],
  [
    /\.pyi?$/i,
    [
      { kind: "suppression", re: /#\s*type:\s*ignore\b/, what: "type error suppressed" },
      { kind: "suppression", re: /#\s*(noqa\b|pyright:\s*ignore|pylint:\s*disable|mypy:\s*ignore-errors)/, what: "lint/type check suppressed inline" },
      { kind: "suppression", re: /#\s*pragma:\s*no\s*cover\b/, what: "code excluded from coverage" },
      { kind: "skip", re: /@pytest\.mark\.(skip|xfail)\b|\bpytest\.skip\(|@unittest\.skip/, what: "test skipped or xfailed" },
      { kind: "stub", re: /\braise NotImplementedError\b/, what: "stub left in (NotImplementedError)" },
    ],
  ],
  [
    /\.rs$/i,
    [
      { kind: "suppression", re: /#!?\[allow\(/, what: "compiler/clippy lint allowed" },
      { kind: "skip", re: /#\[ignore\b/, what: "test ignored" },
      { kind: "stub", re: /\b(todo|unimplemented)!\s*\(/, what: "stub left in (todo!/unimplemented!)" },
    ],
  ],
  [
    /\.go$/i,
    [
      { kind: "suppression", re: /\/\/\s*(nolint\b|lint:ignore\b)/, what: "lint suppressed inline" },
      { kind: "skip", re: /\bt\.Skip(f|Now)?\s*\(/, what: "test skipped" },
      { kind: "stub", re: /\bpanic\(\s*"(not implemented|unimplemented|todo)/i, what: "stub left in (panic)" },
    ],
  ],
  [
    /\.rb$/i,
    [
      { kind: "suppression", re: /#\s*rubocop:(disable|todo)\b/, what: "RuboCop cop disabled inline" },
      { kind: "focus", re: /^\s*(fit|fdescribe|fcontext)\b|\bfocus:\s*true\b/, what: "focused spec" },
      { kind: "skip", re: /^\s*(xit|xdescribe|xcontext|xspecify|pending|skip)\b/, what: "spec skipped or pending" },
    ],
  ],
  [
    /\.(java|kt|kts)$/i,
    [
      { kind: "suppression", re: /@Suppress(Warnings)?\s*\(/, what: "compiler warning suppressed" },
      { kind: "skip", re: /@(Disabled|Ignore)\b/, what: "test disabled" },
      { kind: "stub", re: /throw (new )?(UnsupportedOperationException|NotImplementedError)\(\s*"?(not implemented|todo)?|\bTODO\(\s*\)/i, what: "stub left in" },
    ],
  ],
  [
    /\.cs$/i,
    [
      { kind: "suppression", re: /#pragma warning disable|\[SuppressMessage\(/, what: "compiler warning suppressed" },
      { kind: "skip", re: /\[(Ignore|Explicit)\b|\bSkip\s*=\s*"/, what: "test skipped" },
      { kind: "stub", re: /throw new NotImplementedException/, what: "stub left in (NotImplementedException)" },
    ],
  ],
  [
    /\.swift$/i,
    [
      { kind: "suppression", re: /\/\/\s*swiftlint:disable/, what: "SwiftLint rule disabled inline" },
      { kind: "skip", re: /\bthrow XCTSkip\b|\bXCTSkip(If|Unless)\b/, what: "test skipped" },
      { kind: "stub", re: /fatalError\(\s*"(not implemented|unimplemented|todo)/i, what: "stub left in (fatalError)" },
    ],
  ],
  [
    /\.php$/i,
    [
      { kind: "suppression", re: /@phpstan-ignore|@psalm-suppress|phpcs:(ignore|disable)|@codingStandardsIgnore/, what: "static analysis suppressed inline" },
      { kind: "skip", re: /markTest(Skipped|Incomplete)\s*\(|->skip\(\s*\)/, what: "test skipped" },
    ],
  ],
  [/\.(sh|bash|zsh)$/i, [{ kind: "suppression", re: /#\s*shellcheck\s+disable=/, what: "ShellCheck rule disabled inline" }]],
  [/\.(ex|exs)$/i, [{ kind: "skip", re: /@(module)?tag\s+:skip\b/, what: "test skipped" }]],
  [/\.(c|cc|cpp|cxx|h|hpp)$/i, [{ kind: "suppression", re: /NOLINT|#pragma (GCC|clang) diagnostic ignored/, what: "compiler/lint warning suppressed" }]],
];

/** [path pattern, added-line pattern, what] — configuration changes that make checks weaker. */
const LOOSEN: Array<[RegExp, RegExp, string]> = [
  [/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/, /"(strict|noImplicitAny|strictNullChecks|strictFunctionTypes|noUnusedLocals|noUnusedParameters|noImplicitReturns|noUncheckedIndexedAccess|noFallthroughCasesInSwitch|exactOptionalPropertyTypes|useUnknownInCatchVariables)"\s*:\s*false/, "TypeScript strictness turned off"],
  [/(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/, /:\s*\[?\s*(['"]off['"]|0)\s*[,\]}]?\s*,?\s*$/, "ESLint rule turned off"],
  [/(^|\/)biome\.jsonc?$/, /:\s*"off"|"recommended"\s*:\s*false|"enabled"\s*:\s*false/, "Biome rule or linter turned off"],
  [/(^|\/)(pyproject\.toml|setup\.cfg|mypy\.ini|\.mypy\.ini|tox\.ini|\.flake8|ruff\.toml|\.ruff\.toml)$/, /^\s*(ignore_errors\s*=\s*true|follow_imports\s*=\s*["']?skip)|^\s*(strict|disallow_untyped_defs|check_untyped_defs|warn_return_any)\s*=\s*false|^\s*(extend-)?ignore\s*=|^\s*per-file-ignores\b/i, "Python lint/type-check rules relaxed"],
  [/(^|\/)(Cargo\.toml|clippy\.toml|\.clippy\.toml)$/, /=\s*["']allow["']|level\s*=\s*["']allow["']/, "Rust lint set to allow"],
  [/(^|\/)package\.json$/, /"(test|lint|typecheck|type-check|check)[^"]*"\s*:\s*"[^"]*(\|\|\s*(true|exit 0)|--passWithNoTests\b|;\s*exit 0)/, "check script can no longer fail"],
  [/(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|azure-pipelines\.yml|\.circleci\/config\.yml)$/, /continue-on-error:\s*true|allow_failure:\s*true|\|\|\s*true\b/, "CI step allowed to fail"],
  [/(^|\/)\.golangci\.(ya?ml|toml|json)$/, /^\s*disable-all:\s*true|^\s*issues-exit-code:\s*0/, "golangci-lint relaxed"],
  [/(^|\/)\.rubocop\.yml$/, /^\s*Enabled:\s*false/, "RuboCop cop disabled"],
  [/(^|\/)phpstan\.neon(\.dist)?$/, /^\s*level:\s*[0-4]\b|^\s*ignoreErrors:/, "PHPStan relaxed"],
  [/(^|\/)(jest|vitest)\.config\.[cm]?[jt]s$/, /passWithNoTests:\s*true|(coverageThreshold|thresholds)\b.*:\s*0\b/, "test configuration relaxed"],
];

export const TEST_FILE_RE = /(^|\/)(__tests__|__test__|tests?|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|_test\.go$|_(spec|test)\.rb$|Tests?\.(java|kt|cs|swift)$|Test\.php$|_test\.exs$/;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|rb|java|kt|cs|swift|php|ex|exs)$/i;

/** Test-case markers per language, to notice tests removed from a file. */
const CASES: Array<[RegExp, RegExp]> = [
  [JS, /\b(it|test)(\.(only|skip|todo|concurrent|failing|each\s*\([^)]*\)))*\s*\(\s*['"`]/g],
  [/\.py$/i, /^\s*(async\s+)?def\s+test_\w*\s*\(/gm],
  [/_test\.go$/i, /^func\s+(Test|Benchmark|Fuzz)\w*\s*\(/gm],
  [/\.rs$/i, /#\[(tokio::|async_std::)?test\b/g],
  [/\.rb$/i, /^\s*it\s+['"]|^\s*def\s+test_\w+/gm],
  [/\.(java|kt)$/i, /@(Test|ParameterizedTest)\b/g],
  [/\.cs$/i, /\[(Fact|Theory|Test|TestMethod|TestCase)\b/g],
  [/\.swift$/i, /\bfunc\s+test\w*\s*\(/g],
  [/\.php$/i, /\bfunction\s+test\w*\s*\(|@test\b|^\s*(it|test)\s*\(\s*['"]/gm],
  [/\.exs$/i, /^\s*test\s+"/gm],
];

const SECRETS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{32,}/g, "Anthropic API key"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS access key ID"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "GitHub token"],
  [/\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/g, "OpenAI-style API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}\b/g, "Stripe live key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "Google API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm token"],
  [/\bhf_[A-Za-z0-9]{34,}\b/g, "Hugging Face token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g, "private key"],
];
const PLACEHOLDER = /EXAMPLE|x{6,}|X{6,}|0{8,}|1234567890|your[_-]?(api|key|token)|dummy|fake|placeholder|redacted|\*{4,}/i;
const NO_SECRET_SCAN = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$|\.(min\.js|map)$/;

interface LockRule {
  manifest: RegExp;
  locks: Array<[file: string, fix: string]>;
  /** Fingerprint of the dependency declarations; undefined when unparseable. */
  fp: (text: string) => string | undefined;
  /** Only additions matter (go.mod: removals leave harmless go.sum lines). */
  additionsOnly?: boolean;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function jsonFields(fields: string[]) {
  return (text: string): string | undefined => {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return stable(fields.map((f) => j[f] ?? null));
    } catch {
      return undefined;
    }
  };
}

/** Lines inside dependency sections/arrays of a TOML manifest, normalised and sorted. */
function tomlDeps(text: string): string {
  const out: string[] = [];
  let section = "";
  let inArray = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sec) {
      section = sec[1]!.trim();
      inArray = false;
      continue;
    }
    const depSection = /dependenc|dependency-groups|^packages$|^dev-packages$/.test(section);
    if (inArray) {
      out.push(line);
      if (line.includes("]")) inArray = false;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    if (/dependenc/.test(kv[1]!) && kv[2]!.startsWith("[")) {
      out.push(`${section}:${line}`);
      inArray = !kv[2]!.includes("]");
    } else if (depSection) out.push(`${section}:${line}`);
  }
  return out.map((l) => l.replace(/\s+/g, "")).sort().join("\n");
}

function goRequires(text: string): string {
  const mods = new Set<string>();
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) inBlock = true;
    else if (inBlock && line === ")") inBlock = false;
    else if (inBlock && line) mods.add(line.split(/\s+/)[0]!);
    else {
      const m = line.match(/^require\s+(\S+)\s+\S+/);
      if (m) mods.add(m[1]!);
    }
  }
  return Array.from(mods).sort().join("\n");
}

const LOCK_RULES: LockRule[] = [
  {
    manifest: /(^|\/)package\.json$/,
    locks: [["pnpm-lock.yaml", "pnpm install"], ["package-lock.json", "npm install"], ["npm-shrinkwrap.json", "npm install"], ["yarn.lock", "yarn install"], ["bun.lock", "bun install"], ["bun.lockb", "bun install"]],
    fp: jsonFields(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]),
  },
  { manifest: /(^|\/)pyproject\.toml$/, locks: [["uv.lock", "uv lock"], ["poetry.lock", "poetry lock"], ["pdm.lock", "pdm lock"]], fp: tomlDeps },
  { manifest: /(^|\/)Pipfile$/, locks: [["Pipfile.lock", "pipenv lock"]], fp: tomlDeps },
  { manifest: /(^|\/)go\.mod$/, locks: [["go.sum", "go mod tidy"]], fp: goRequires, additionsOnly: true },
  { manifest: /(^|\/)composer\.json$/, locks: [["composer.lock", "composer update --lock"]], fp: jsonFields(["require", "require-dev"]) },
  { manifest: /(^|\/)Gemfile$/, locks: [["Gemfile.lock", "bundle install"]], fp: (t) => t.split("\n").filter((l) => /^\s*gem\s+['"]/.test(l)).map((l) => l.trim()).sort().join("\n") },
];

function findLock(manifestAbs: string, rule: LockRule, stop: string): { abs: string; fix: string } | undefined {
  let dir = dirname(manifestAbs);
  for (let i = 0; i < 12; i++) {
    for (const [file, fix] of rule.locks) {
      const p = join(dir, file);
      if (existsSync(p)) return { abs: p, fix };
    }
    if (dir === stop || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
  return undefined;
}

function countCases(file: string, text: string): number | undefined {
  const rule = CASES.find(([re]) => re.test(file));
  if (!rule) return undefined;
  return (text.match(rule[1]) ?? []).length;
}

function mask(token: string): string {
  return `${token.slice(0, 4)}… (${token.length} chars)`;
}

export interface FindingsInput {
  /** Project root: display paths are relative to it when possible. */
  root: string;
  gitRoot?: string;
  /** Absolute paths changed during this task. */
  files: string[];
  /** Content at the start of the task: null = did not exist, SKIP = unknown. */
  before: (abs: string) => Before;
  /** Is this path ignored by git? (undefined = cannot tell) */
  ignored?: (abs: string) => boolean | undefined;
}

/** Findings for the task's changes, grouped (one entry per kind/file/pattern) and sorted. */
export function collectFindings(input: FindingsInput): Finding[] {
  const out: Finding[] = [];
  const base = (abs: string) => {
    for (const b of [input.root, input.gitRoot]) {
      if (!b) continue;
      const r = relative(b, abs);
      if (!r.startsWith("..")) return r.split(sep).join("/");
    }
    return abs.split(sep).join("/");
  };
  const add = (kind: FindingKind, file: string, what: string, lines: number[], extra: Partial<Finding> = {}) => {
    const existing = out.find((f) => f.kind === kind && f.file === file && f.what === what);
    if (existing) {
      existing.lines.push(...lines);
      return;
    }
    out.push({ kind, file, what, lines: [...lines], key: "", ...extra });
  };
  const changed = new Set(input.files);
  for (const abs of input.files.slice(0, 300)) {
    const file = base(abs);
    const after = readForDiff(abs);
    const before = input.before(abs);
    if (after === null) {
      // Deleted during the task.
      if (before !== null && TEST_FILE_RE.test(file) && CODE_EXT.test(file)) add("deleted-test", file, "test file deleted", []);
      continue;
    }
    if (after === SKIP || before === SKIP) continue;
    const added = addedLines(before ?? "", after);
    // secrets
    if (!NO_SECRET_SCAN.test(file)) {
      for (const { line, text } of added) {
        for (const [re, what] of SECRETS) {
          re.lastIndex = 0;
          for (const m of text.matchAll(re)) {
            if (PLACEHOLDER.test(m[0]) || PLACEHOLDER.test(text)) continue;
            add("secret", file, what, [line], { sample: what === "private key" ? "private key block" : mask(m[0]) });
          }
        }
      }
    }
    // .env files that would be committed
    const name = basename(file);
    if (/^\.env(\.[\w.-]+)?$/.test(name) && !/\.(example|sample|template|dist|defaults)$/i.test(name) && input.ignored?.(abs) === false) add("env-file", file, "environment file is not gitignored (it would be committed)", []);
    // suppressions, skips, focus, stubs
    const pats = CODE_PATTERNS.find(([re]) => re.test(file))?.[1] ?? [];
    for (const { line, text } of added) {
      for (const p of pats) if (p.re.test(text)) add(p.kind, file, p.what, [line], { sample: text.trim().slice(0, 90) });
    }
    // configuration loosened
    for (const [pathRe, lineRe, what] of LOOSEN) {
      if (!pathRe.test(file)) continue;
      for (const { line, text } of added) if (lineRe.test(text)) add("loosen", file, what, [line], { sample: text.trim().slice(0, 90) });
    }
    // test cases removed from a test file
    if (before !== null && (TEST_FILE_RE.test(file) || /\.(test|spec)\./.test(file))) {
      const was = countCases(file, before);
      const now = countCases(file, after);
      if (was !== undefined && now !== undefined && now < was) add("removed-tests", file, `${was - now} test case${was - now === 1 ? "" : "s"} removed`, []);
    }
    // dependencies changed without the lockfile
    const rule = LOCK_RULES.find((r) => r.manifest.test(file));
    if (rule && before !== null) {
      const fb = rule.fp(before);
      const fa = rule.fp(after);
      const grew = rule.additionsOnly ? fa !== undefined && fa.split("\n").some((m) => m && !(fb ?? "").split("\n").includes(m)) : fb !== fa;
      if (fb !== undefined && fa !== undefined && grew) {
        const lock = findLock(abs, rule, input.gitRoot ?? input.root);
        if (lock && !changed.has(lock.abs)) add("lockfile", file, `dependencies changed but ${base(lock.abs)} was not updated`, [], { fix: lock.fix });
      }
    }
  }
  const order: FindingKind[] = ["secret", "env-file", "lockfile", "focus", "suppression", "skip", "stub", "loosen", "deleted-test", "removed-tests"];
  for (const f of out) {
    f.lines = Array.from(new Set(f.lines)).sort((a, b) => a - b);
    f.key = `${f.kind}|${f.file}|${f.what}|${f.lines.length}`;
  }
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.file.localeCompare(b.file) || a.what.localeCompare(b.what)).slice(0, 40);
}

/** Findings that should interrupt the agent regardless of how the task went. */
export function mustFix(f: Finding): boolean {
  return f.kind === "secret" || f.kind === "lockfile" || f.kind === "focus";
}

/** Findings that look like making a check pass the wrong way. */
export function isWeakening(f: Finding): boolean {
  return f.kind === "suppression" || f.kind === "skip" || f.kind === "stub" || f.kind === "loosen" || f.kind === "deleted-test" || f.kind === "removed-tests";
}

export function formatFinding(f: Finding): string {
  const where = f.lines.length ? `${f.file}:${f.lines.slice(0, 6).join(",")}${f.lines.length > 6 ? ",…" : ""}` : f.file;
  if (f.kind === "secret") return `- possible ${f.what} in ${where} (${f.sample}); the value is not repeated here`;
  const count = f.lines.length > 1 ? ` ×${f.lines.length}` : "";
  return `- ${f.what}${count}: ${where}${f.sample ? ` — \`${f.sample.replace(/`/g, "'")}\`` : ""}${f.fix ? ` — fix: \`${f.fix}\`` : ""}`;
}

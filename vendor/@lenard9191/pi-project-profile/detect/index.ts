import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { exists, findGitRoot, findUp, realpath } from "../fs-utils.ts";
import type { DetectedProfile, ProfileConfig, Tier } from "../types.ts";
import { Builder } from "./context.ts";
import { detectGo } from "./go.ts";
import { detectNode } from "./node.ts";
import { detectDart, detectDeno, detectDotnet, detectElixir, detectFunctional, detectInfra, detectJvm, detectNative, detectPhp, detectRuby, detectSwift } from "./others.ts";
import { detectPython } from "./python.ts";
import { detectCI, detectConventions, detectInstructions, detectRepoShape, detectServices, detectTaskRunners } from "./repo.ts";
import { detectRust } from "./rust.ts";

/** Bump when detector output changes shape/semantics so caches refresh. */
export const DETECTOR_VERSION = 14;

const LANG_EXTS: Record<string, string[]> = { TypeScript: [".ts", ".tsx", ".mts", ".cts"], JavaScript: [".js", ".jsx", ".mjs", ".cjs"], Python: [".py"], Rust: [".rs"], Go: [".go"], Ruby: [".rb"], Java: [".java"], Kotlin: [".kt", ".kts"], Scala: [".scala"], Swift: [".swift"], PHP: [".php"], Elixir: [".ex", ".exs"], Dart: [".dart"], C: [".c", ".h"], "C++": [".cc", ".cpp", ".cxx", ".hpp"], Zig: [".zig"], Haskell: [".hs"], OCaml: [".ml", ".mli"], "C#": [".cs"], "F#": [".fs"], Lua: [".lua"], Perl: [".pl", ".pm"], Erlang: [".erl"], Gleam: [".gleam"], Nim: [".nim"], Julia: [".jl"], R: [".r"], "HCL (Terraform)": [".tf"], Shell: [".sh", ".bash"], Markdown: [".md"] };

/** Which root manifest a CI command needs to make sense when run from the project root. */
const CI_MANIFEST: Array<[RegExp, string[]]> = [
  [/^cargo\b/, ["Cargo.toml"]],
  [/^go\b|^gofmt|^golangci|^staticcheck/, ["go.mod"]],
  [/^(ruff|mypy|pyright|black|isort|flake8|pylint|pytest|uv run|poetry run|pdm run|tox|nox|hatch)\b/, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini", "Pipfile"]],
  [/^(pnpm|npm|yarn|bun|npx|tsc|eslint|prettier|biome)\b/, ["package.json"]],
  [/^mix\b/, ["mix.exs"]],
  [/^(dart|flutter)\b/, ["pubspec.yaml"]],
  [/^terraform\b|^tofu\b/, [".tf"]],
  [/^deno\b/, ["deno.json", "deno.jsonc"]],
  [/^swiftlint|^swift-format|^swift\b/, ["Package.swift", ".swiftlint.yml"]],
  [/^dotnet\b/, [".sln", ".csproj"]],
  [/^\.\/gradlew|^gradle\b/, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]],
  [/^(bundle exec )?(rubocop|rspec|rake)\b/, ["Gemfile"]],
  [/^vendor\/bin|^composer\b|^php\b/, ["composer.json"]],
  [/^zig\b/, ["build.zig"]],
];

function ciCommandFitsRoot(b: Builder, cmd: string): boolean {
  for (const [re, manifests] of CI_MANIFEST) {
    if (!re.test(cmd)) continue;
    return manifests.some((m) => (m.startsWith(".") && !m.includes("/") && !/^\.[a-z]+\.yml$/.test(m) ? b.rootFiles(new RegExp(m.replace(".", "\\.") + "$")).length > 0 : b.hasFile(m)));
  }
  return true;
}

/** Umbrella repos: no manifest at root, but packages below. */
function detectSubprojects(b: Builder): void {
  if (MANIFESTS.some((m) => b.hasFile(m))) return;
  const found: string[] = [];
  const langs = new Set<string>();
  const scan = (rel: string, depth: number) => {
    if (found.length >= 40 || depth > 2) return;
    for (const d of b.dirs(rel)) {
      if (d.startsWith(".") || b.opts.ignoreDirs.includes(d)) continue;
      const sub = rel === "." ? d : `${rel}/${d}`;
      const hit = MANIFESTS.find((m) => b.hasFile(`${sub}/${m}`));
      if (hit) {
        found.push(sub);
        const lang: Record<string, string> = { "package.json": "TypeScript/JavaScript", "Cargo.toml": "Rust", "go.mod": "Go", "pyproject.toml": "Python", "setup.py": "Python", "Gemfile": "Ruby", "pom.xml": "Java", "build.gradle": "Java/Kotlin", "build.gradle.kts": "Kotlin", "Package.swift": "Swift", "composer.json": "PHP", "mix.exs": "Elixir", "pubspec.yaml": "Dart", "CMakeLists.txt": "C/C++", "build.zig": "Zig" };
        if (lang[hit]) langs.add(lang[hit]!);
      } else scan(sub, depth + 1);
    }
  };
  scan(".", 0);
  if (found.length === 0) return;
  b.monorepo = { kind: "multi-project repo", packages: found.length, dirs: found };
  b.add(`multi-project repo: ${found.slice(0, 8).join(", ")}${found.length > 8 ? ` (+${found.length - 8})` : ""}`);
  for (const l of langs) b.lang(l);
  b.note("no manifest at the repo root — run pi from inside a package for commands and checks, or /profile set them here");
}

/** Files that mark a project root (nearest one upward from cwd wins). */
export const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "Package.swift",
  "composer.json",
  "mix.exs",
  "pubspec.yaml",
  "CMakeLists.txt",
  "meson.build",
  "build.zig",
  "deno.json",
  "deno.jsonc",
  "stack.yaml",
  "cabal.project",
  "build.sbt",
  "dune-project",
  "Makefile",
  "justfile",
  "Taskfile.yml",
  "mkdocs.yml",
  "flake.nix",
  "gleam.toml",
  "rebar.config",
];

export function isProjectDir(dir: string): boolean {
  return MANIFESTS.some((m) => exists(join(dir, m)));
}

/**
 * Find the project root for a cwd: the nearest ancestor (up to the git root)
 * that has a manifest; falls back to the git root, then cwd.
 *
 * Without a git root the walk stops below the home directory: a stray
 * `~/package.json` must never turn `~` (and its private layout) into the
 * project for everything underneath it.
 */
export function findProjectRoot(cwd: string): { root: string; gitRoot?: string } {
  const start = realpath(cwd);
  const home = realpath(homedir());
  // A dotfiles repo rooted at ~ is not a project either; ignore it entirely.
  const foundGit = findGitRoot(start);
  const gitRoot = foundGit === home ? undefined : foundGit;
  const belowHome = start !== home && start.startsWith(home + sep);
  const stop = gitRoot ?? (belowHome ? home : undefined);
  const nearest = findUp(start, (d) => d !== home && isProjectDir(d), stop);
  const root = nearest ?? gitRoot ?? start;
  return { root, gitRoot };
}

export function detectProject(root: string, config: ProfileConfig, gitRoot?: string): DetectedProfile {
  const timeouts: Record<Tier, number> = {
    syntax: 30_000,
    fast: config.verify.fastTimeoutMs,
    lint: config.verify.fastTimeoutMs,
    test: config.verify.testTimeoutMs,
    build: config.verify.buildTimeoutMs,
  };
  const b = new Builder(root, { ignoreDirs: config.ignoreDirs, timeouts });
  const shape = detectRepoShape(b, gitRoot);
  b.extCounts = shape.extCounts;
  // Detectors run in order of how much of the repo their language covers, so the
  // primary ecosystem claims the shared command keys (test, build, …) first.
  const detectors: Array<[(b: Builder) => void, string[]]> = [
    [detectNode, ["TypeScript", "JavaScript"]],
    [detectDeno, ["TypeScript"]],
    [detectRust, ["Rust"]],
    [detectGo, ["Go"]],
    [detectPython, ["Python"]],
    [detectRuby, ["Ruby"]],
    [detectJvm, ["Java", "Kotlin", "Scala"]],
    [detectDotnet, ["C#", "F#"]],
    [detectSwift, ["Swift"]],
    [detectPhp, ["PHP"]],
    [detectElixir, ["Elixir"]],
    [detectDart, ["Dart"]],
    [detectNative, ["C", "C++", "Zig"]],
    [detectFunctional, ["Haskell", "Scala", "OCaml", "Gleam", "Erlang"]],
    [detectInfra, ["HCL (Terraform)", "Shell", "Lua", "Perl"]],
  ];
  const weightOf = (langs: string[]) => Math.max(0, ...langs.map((l) => (LANG_EXTS[l] ?? []).reduce((n, e) => n + (shape.extCounts[e] ?? 0), 0)));
  const ordered = detectors.map((d, i) => ({ d: d[0], w: weightOf(d[1]), i })).sort((x, y) => y.w - x.w || x.i - y.i);
  const safe = (d: (b: Builder) => void) => {
    try {
      d(b);
    } catch (err) {
      b.note(`detector ${d.name} failed: ${(err as Error).message}`);
    }
  };
  for (const { d } of ordered) safe(d);
  safe(detectSubprojects);
  let ci: DetectedProfile["ci"];
  try {
    ci = detectCI(b);
  } catch (err) {
    b.note(`CI detection failed: ${(err as Error).message}`);
  }
  // CI-derived checks are a stronger signal than generic task-runner targets, so they go first.
  if (ci) addCiChecks(b, ci.runs);
  for (const d of [detectTaskRunners, detectConventions, detectServices]) safe(d);
  const instructionFiles = detectInstructions(b, { inline: config.profile.inlineInstructionFiles, maxFile: config.profile.maxInstructionFileChars, maxTotal: config.profile.maxInstructionTotalChars });
  // json validation is universal
  b.check({ id: "json:syntax", tier: "syntax", label: "syntax", cmd: "JSON.parse <files>", argv: ["__internal_json__"], appendFiles: true, source: "built-in", exts: [".json"], tool: "json" });
  // Order languages by how much of the repo they cover (git ls-files extension histogram).
  const weight = (lang: string) => (LANG_EXTS[lang] ?? []).reduce((n, e) => n + (shape.extCounts[e] ?? 0), 0);
  const languages = Array.from(b.languages).sort((x, y) => weight(y) - weight(x));
  b.languages = new Set(languages);
  const profile = b.finish({
    version: DETECTOR_VERSION,
    root,
    gitRoot,
    remote: shape.remote,
    trackedFiles: shape.trackedFiles,
    name: shape.name ?? basename(root),
    instructionFiles,
    ci,
    layout: shape.layout,
    tests: shape.tests,
  });
  if (profile.languages.length === 0) {
    // Guess language from file extensions at the top level
    const files = b.files();
    const guess = (re: RegExp, lang: string) => files.some((f) => re.test(f)) && b.lang(lang);
    guess(/\.(ts|tsx)$/, "TypeScript") || guess(/\.(js|mjs|cjs)$/, "JavaScript");
    guess(/\.py$/, "Python");
    guess(/\.rs$/, "Rust");
    guess(/\.go$/, "Go");
    guess(/\.rb$/, "Ruby");
    guess(/\.(sh|bash)$/, "Shell");
    guess(/\.md$/, "Markdown");
    profile.languages = Array.from(b.languages);
    if (profile.languages.length === 0) profile.notes.push("no known project manifest found — generic profile");
  }
  return profile;
}

/** Turn read-only commands found in CI into lint/fast checks (they encode what the project enforces). */
function addCiChecks(b: Builder, runs: string[]): void {
  const covered = (tier: Tier, label: string) => b.hasCheckFor(tier, label);
  for (const cmd of runs) {
    if (!ciCommandFitsRoot(b, cmd)) continue;
    let tier: Tier | undefined;
    let label = "ci";
    let tool = "generic";
    let exts: string[] | undefined;
    if (/^cargo clippy/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "cargo", [".rs", ".toml"]];
    else if (/^cargo fmt/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "rustfmt", [".rs"]];
    else if (/^cargo doc/.test(cmd)) continue;
    else if (/^golangci-lint/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "golangci", [".go"]];
    else if (/^staticcheck/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "go", [".go"]];
    else if (/^ruff check/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "ruff", [".py"]];
    else if (/^ruff format --check/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "ruff", [".py"]];
    else if (/^(mypy|pyright)\b/.test(cmd)) [tier, label, tool, exts] = ["fast", "typecheck", cmd.split(" ")[0]!, [".py"]];
    else if (/^black --check/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "black", [".py"]];
    else if (/^isort --check/.test(cmd)) [tier, label, tool, exts] = ["lint", "imports", "isort", [".py"]];
    else if (/^(flake8|pylint)\b/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "flake8", [".py"]];
    else if (/^(pnpm|npm run|yarn|bun run) (typecheck|type-check|check)\b/.test(cmd)) [tier, label, tool, exts] = ["fast", "typecheck", "tsc", [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"]];
    else if (/^(npx tsc|tsc --noEmit)/.test(cmd)) [tier, label, tool, exts] = ["fast", "typecheck", "tsc", [".ts", ".tsx"]];
    else if (/^(pnpm|npm run|yarn|bun run) lint\b/.test(cmd) && !/--fix/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "eslint", [".ts", ".tsx", ".js", ".jsx"]];
    else if (/^(pnpm|npm run|yarn|bun run) (format:check|fmt:check|prettier:check)/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "prettier", undefined];
    else if (/^prettier --check/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "prettier", undefined];
    else if (/^biome (check|ci|lint)/.test(cmd) && !/--write|--apply/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "biome", [".ts", ".tsx", ".js", ".jsx", ".json"]];
    else if (/^eslint\b/.test(cmd) && !/--fix/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "eslint", [".ts", ".tsx", ".js", ".jsx"]];
    else if (/^mix format --check-formatted/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "mix", [".ex", ".exs"]];
    else if (/^mix credo/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "credo", [".ex", ".exs"]];
    else if (/^mix compile/.test(cmd)) [tier, label, tool, exts] = ["fast", "compile", "mix", [".ex", ".exs"]];
    else if (/^(dart|flutter) analyze/.test(cmd)) [tier, label, tool, exts] = ["fast", "analyze", "dart", [".dart"]];
    else if (/^terraform (fmt -check|validate)/.test(cmd)) [tier, label, tool, exts] = ["lint", cmd.includes("validate") ? "validate" : "format", "terraform", [".tf"]];
    else if (/^shellcheck/.test(cmd)) continue; // needs file args; handled by PATH detection
    else if (/^deno (check|lint|fmt --check)/.test(cmd)) [tier, label, tool, exts] = [cmd.includes("check") && !cmd.includes("fmt") ? "fast" : "lint", cmd.split(" ")[1]!, "deno", [".ts", ".tsx"]];
    else if (/^swiftlint/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "swiftlint", [".swift"]];
    else if (/^dotnet format --verify-no-changes/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "dotnet", [".cs"]];
    else if (/^\.\/gradlew spotlessCheck/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "gradle", [".java", ".kt"]];
    else if (/^(bundle exec )?rubocop/.test(cmd) && !/-[aA]\b|--auto-?correct/.test(cmd)) [tier, label, tool, exts] = ["lint", "lint", "rubocop", [".rb"]];
    else if (/^vendor\/bin\/(phpstan|psalm)/.test(cmd)) [tier, label, tool, exts] = ["fast", "analyse", "phpstan", [".php"]];
    else if (/^clang-format --dry-run/.test(cmd)) continue;
    else if (/^zig fmt --check/.test(cmd)) [tier, label, tool, exts] = ["lint", "format", "zig", [".zig"]];
    else if (/^go vet/.test(cmd)) [tier, label, tool, exts] = ["fast", "vet", "go", [".go"]];
    else if (/^gofmt -l/.test(cmd)) continue;
    else continue; // tests/builds from CI are display-only: they often need services/secrets
    if (!tier) continue;
    if (covered(tier, label)) continue;
    const head = cmd.split(/\s+/)[0]!;
    const requires = head.startsWith("./") ? { files: [head.slice(2)], hint: `${head} missing` } : { bin: head, hint: `${head} not on PATH` };
    b.check({ id: `ci:${label}:${b.checks.length}`, tier, label, cmd, argv: ["sh", "-c", cmd], viaShell: true, source: "CI workflow", exts, tool, requires });
  }
}

/** Nearest project dir for a file: walks up from the file's directory to `stop` (inclusive). */
export function nearestProjectDir(file: string, stop: string): string {
  let dir = dirname(file);
  for (;;) {
    if (isProjectDir(dir)) return dir;
    if (dir === stop || dirname(dir) === dir) return stop;
    dir = dirname(dir);
  }
}

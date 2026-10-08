/**
 * Cross-ecosystem detectors: task runners, CI, conventions, instruction files,
 * repository shape, services.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { clampText, exists, isDir, listDirs, listFiles, readText } from "../fs-utils.ts";
import type { InstructionFile, Tier } from "../types.ts";
import type { Builder } from "./context.ts";
import { composeServices } from "./context.ts";
import { generatedPatterns } from "../profile/scoped.ts";
import { testConventions } from "./tests.ts";

// ---------------------------------------------------------------- Task runners
const TARGET_KEYS: Array<[RegExp, string]> = [
  [/^(typecheck|type-check|types|check-types|tsc)$/, "typecheck"],
  [/^(lint|lints|eslint|clippy)$/, "lint"],
  [/^(fmt|format)$/, "format"],
  [/^(test|tests|unit|unit-test|unit-tests|spec)$/, "test"],
  [/^(e2e|integration|integration-test|integration-tests|test-e2e|test-integration)$/, "e2e"],
  [/^(build|compile|dist|all)$/, "build"],
  [/^(dev|serve|run|start|watch)$/, "dev"],
  [/^(docs|doc)$/, "docs"],
  [/^(migrate|migrations|db-migrate)$/, "migrate"],
  [/^(install|deps|setup|bootstrap)$/, "install"],
  [/^(clean)$/, "clean"],
  [/^(generate|gen|codegen|generate-all)$/, "generate"],
];

/** Read-only-ish targets we are willing to run as checks when nothing ecosystem-specific exists. */
const CHECK_TARGETS: Array<[RegExp, Tier, string]> = [
  [/^(lint|lints)$/, "lint", "lint"],
  [/^(typecheck|type-check|check-types)$/, "fast", "typecheck"],
  [/^(fmt-check|format-check|check-format|check-fmt|fmt_check)$/, "lint", "format"],
  [/^(test|tests|unit|unit-tests?)$/, "test", "test"],
  [/^(build|compile)$/, "build", "build"],
];

export function detectTaskRunners(b: Builder): void {
  // Makefile
  const mk = b.first(["Makefile", "makefile", "GNUmakefile"]);
  if (mk) {
    const text = b.text(mk) ?? "";
    const targets = Array.from(text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.\/-]*)\s*:(?!=)/gm)).map((m) => m[1]!).filter((t) => !t.startsWith(".") && !/[%$]/.test(t));
    const uniqTargets = Array.from(new Set(targets));
    if (uniqTargets.length) {
      b.add(`Makefile (${uniqTargets.length} targets)`);
      applyTargets(b, uniqTargets, (t) => `make ${t}`, (t) => ["make", t], mk, { bin: "make", hint: "make not on PATH" });
    }
  }
  // justfile
  const just = b.first(["justfile", "Justfile", ".justfile", "justfile.just"]);
  if (just) {
    const text = b.text(just) ?? "";
    const recipes = Array.from(text.matchAll(/^(?:@)?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:\n]*)?\s*:(?!=)/gm)).map((m) => m[1]!);
    const uniqRecipes = Array.from(new Set(recipes));
    if (uniqRecipes.length) {
      b.add(`just (${uniqRecipes.length} recipes)`);
      applyTargets(b, uniqRecipes, (t) => `just ${t}`, (t) => ["just", t], just, { bin: "just", hint: "just not on PATH" });
    }
  }
  // Taskfile
  const taskfile = b.first(["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "Taskfile.dist.yml"]);
  if (taskfile) {
    const text = b.text(taskfile) ?? "";
    const m = text.match(/^tasks:\s*\n([\s\S]*)/m);
    const names = m ? Array.from(m[1]!.matchAll(/^  ([A-Za-z0-9_:-]+):/gm)).map((x) => x[1]!) : [];
    if (names.length) {
      b.add(`Taskfile (${names.length} tasks)`);
      applyTargets(b, names, (t) => `task ${t}`, (t) => ["task", t], taskfile, { bin: "task", hint: "task (go-task) not on PATH" });
    }
  }
  // mise / earthly / bazel / nx etc.
  if (b.hasFile(".mise.toml") || b.hasFile("mise.toml")) b.add("mise");
  if (b.hasFile("Earthfile")) b.add("Earthly");
  if (b.hasFile("WORKSPACE") || b.hasFile("WORKSPACE.bazel") || b.hasFile("MODULE.bazel")) {
    b.add("Bazel");
    b.command("build", "bazel build //...", "Bazel");
    b.command("test", "bazel test //...", "Bazel");
  }
  if (b.hasFile("BUCK") || b.hasFile(".buckconfig")) b.add("Buck");
  if (b.hasFile("pants.toml")) b.add("Pants");
  if (b.hasFile("dagger.json")) b.add("Dagger");
  const scriptsDir = ["scripts", "script", "bin", "tools"].find((d) => b.hasDir(d));
  if (scriptsDir) {
    const all = b.files(scriptsDir);
    const files = all.slice(0, 6);
    if (files.length) b.note(`${scriptsDir}/: ${files.join(", ")}${all.length > 6 ? `, … (${all.length} files)` : ""}`);
  }
}

function applyTargets(b: Builder, targets: string[], display: (t: string) => string, argv: (t: string) => string[], source: string, requires: { bin: string; hint: string }): void {
  const covered = new Set(Object.keys(b.commands));
  for (const t of targets) {
    for (const [re, key] of TARGET_KEYS) {
      if (re.test(t) && !covered.has(key)) {
        b.command(key, display(t), source);
        covered.add(key);
      }
    }
  }
  // Only add checks for tiers that have nothing ecosystem-specific yet.
  for (const t of targets) {
    for (const [re, tier, label] of CHECK_TARGETS) {
      if (!re.test(t)) continue;
      if (b.hasCheckFor(tier, label)) continue;
      if (b.checks.some((c) => c.id === `${source}:${t}`)) continue;
      b.check({ id: `${source}:${t}`, tier, label, cmd: display(t), argv: argv(t), source: `${source} target ${t}`, requires, tool: "generic" });
    }
  }
}

// ---------------------------------------------------------------- CI
const CI_CHECK_RE = /^(cargo (clippy|fmt --check|fmt -- --check|check|test|doc)|go (vet|build|test)|gofmt -l|golangci-lint run|staticcheck|ruff (check|format --check)|mypy|pyright|black --check|isort --check|flake8|pylint|pytest|(pnpm|npm run|yarn|bun run) (typecheck|type-check|check|lint|test|build|format:check|fmt:check|prettier:check)|npx tsc|tsc --noEmit|mix (format --check-formatted|compile --warnings-as-errors|credo|test)|dart (analyze|format --set-exit-if-changed)|flutter (analyze|test)|terraform (fmt -check|validate)|shellcheck|prettier --check|biome (check|ci|lint)|eslint|deno (check|lint|fmt --check|test)|swiftlint|swift-format lint|zig (fmt --check|build)|clang-format --dry-run|dotnet (build|test|format --verify-no-changes)|\.\/gradlew (check|test|build|compileJava|spotlessCheck)|\.\/mvnw|mvn|bundle exec (rubocop|rspec|rake)|rubocop|rspec|composer (test|lint)|vendor\/bin\/(phpstan|psalm|phpunit|pest|pint)|php artisan test|make (test|lint|check)|just (test|lint|check)|task (test|lint|check)|tox|nox|hatch (test|run)|uv run (pytest|mypy|ruff)|poetry run (pytest|mypy|ruff)|pdm run|sbt|cabal (build|test)|stack (build|test)|dune (build|test)|swift (build|test)|xcodebuild|ctest|cmake --build|meson (compile|test)|bazel (build|test)|nx (affected|run-many)|turbo run|lerna run)\b/;

export function detectCI(b: Builder): { provider: string; files: string[]; runs: string[] } | undefined {
  const files: string[] = [];
  const runs: string[] = [];
  let provider = "";
  const collect = (text: string, lineRe: RegExp) => {
    for (const m of text.matchAll(lineRe)) {
      const raw = m[1]!.trim().replace(/^['"]|['"]$/g, "");
      if (!raw || raw === "|" || raw === ">") continue;
      for (const part of raw.split(/\s*(?:&&|;|\n)\s*/)) {
        const cmd = part.trim();
        if (cmd && CI_CHECK_RE.test(cmd) && !runs.includes(cmd)) runs.push(cmd);
      }
    }
  };
  const gh = join(b.root, ".github", "workflows");
  if (isDir(gh)) {
    provider = "GitHub Actions";
    for (const f of listFiles(gh).filter((f) => /\.ya?ml$/.test(f))) {
      files.push(f);
      const text = readText(join(gh, f), 200_000) ?? "";
      b.fingerprintFiles.add(`.github/workflows/${f}`);
      collect(text, /^\s*(?:-\s*)?run:\s*(.+)$/gm);
      // multi-line run: |
      for (const block of text.matchAll(/run:\s*[|>]-?\s*\n((?:[ \t]+[^\n]*\n?)+)/g)) collect(block[1]!.replace(/^[ \t]+/gm, "").replace(/\s*\\\n\s*/g, " "), /^(.+)$/gm);
    }
  }
  const gl = b.text(".gitlab-ci.yml");
  if (gl) {
    provider = provider || "GitLab CI";
    files.push(".gitlab-ci.yml");
    collect(gl, /^\s*-\s*(.+)$/gm);
  }
  if (b.hasFile(".circleci/config.yml")) {
    provider = provider || "CircleCI";
    files.push(".circleci/config.yml");
    collect(b.text(".circleci/config.yml") ?? "", /^\s*(?:-\s*)?(?:run|command):\s*(.+)$/gm);
  }
  if (b.hasFile("azure-pipelines.yml")) {
    provider = provider || "Azure Pipelines";
    files.push("azure-pipelines.yml");
    collect(b.text("azure-pipelines.yml") ?? "", /^\s*-\s*(?:script|bash):\s*(.+)$/gm);
  }
  if (b.hasFile(".travis.yml")) {
    provider = provider || "Travis CI";
    files.push(".travis.yml");
    collect(b.text(".travis.yml") ?? "", /^\s*-\s*(.+)$/gm);
  }
  if (b.hasFile("Jenkinsfile")) {
    provider = provider || "Jenkins";
    files.push("Jenkinsfile");
    collect(b.text("Jenkinsfile") ?? "", /sh\s*\(?\s*['"](.+?)['"]/g);
  }
  if (b.hasFile(".buildkite/pipeline.yml")) {
    provider = provider || "Buildkite";
    files.push(".buildkite/pipeline.yml");
    collect(b.text(".buildkite/pipeline.yml") ?? "", /^\s*(?:-\s*)?command:\s*(.+)$/gm);
  }
  if (b.hasFile("bitbucket-pipelines.yml")) {
    provider = provider || "Bitbucket Pipelines";
    files.push("bitbucket-pipelines.yml");
    collect(b.text("bitbucket-pipelines.yml") ?? "", /^\s*-\s*(.+)$/gm);
  }
  if (b.hasFile("cloudbuild.yaml")) {
    provider = provider || "Cloud Build";
    files.push("cloudbuild.yaml");
  }
  if (b.hasFile(".woodpecker.yml") || b.hasDir(".woodpecker")) {
    provider = provider || "Woodpecker";
  }
  if (!provider) return undefined;
  return { provider, files: files.slice(0, 12), runs: runs.slice(0, 10) };
}

// ---------------------------------------------------------------- Conventions
export function detectConventions(b: Builder): void {
  // Generated code: linguist-generated patterns, and the command that regenerates.
  b.generated = generatedPatterns(b.text(".gitattributes"));
  if (b.hasFile("buf.gen.yaml") || b.hasFile("buf.gen.yml")) b.command("generate", "buf generate", "buf.gen.yaml");
  if (b.hasFile("sqlc.yaml") || b.hasFile("sqlc.yml") || b.hasFile("sqlc.json")) b.command("generate", "sqlc generate", "sqlc config");

  const ec = b.text(".editorconfig");
  if (ec) {
    const star = ec.match(/^\[\*\]\s*\n([\s\S]*?)(?=^\[|\Z)/m)?.[1] ?? "";
    const style = star.match(/indent_style\s*=\s*(\w+)/)?.[1];
    const size = star.match(/indent_size\s*=\s*(\w+)/)?.[1];
    const desc = style === "tab" || size === "tab" ? "tabs" : style === "space" ? (size && /^\d+$/.test(size) ? `${size} spaces` : "spaces") : undefined;
    b.convention(`EditorConfig${desc ? ` (${desc})` : ""}`);
  }
  if (b.hasFile(".pre-commit-config.yaml")) {
    const cfg = b.text(".pre-commit-config.yaml") ?? "";
    const hooks = Array.from(new Set(Array.from(cfg.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_-]+)/gm)).map((m) => m[1]!))).filter((h) => !/^(check-|end-of-file|trailing-whitespace|mixed-line|detect-)/.test(h)).slice(0, 8);
    b.convention(`pre-commit${hooks.length ? ` (${hooks.join(", ")})` : ""}`);
    b.command("lint", "pre-commit run --all-files", ".pre-commit-config.yaml");
  }
  if (b.hasFile("lefthook.yml") || b.hasFile(".lefthook.yml")) b.convention("Lefthook git hooks");
  if (b.hasFile(".github/CODEOWNERS") || b.hasFile("CODEOWNERS") || b.hasFile("docs/CODEOWNERS")) b.convention("CODEOWNERS");
  if (b.hasFile(".github/PULL_REQUEST_TEMPLATE.md") || b.hasFile("PULL_REQUEST_TEMPLATE.md") || b.hasDir(".github/PULL_REQUEST_TEMPLATE")) b.convention("PR template");
  if (b.hasFile("CHANGELOG.md") || b.hasFile("CHANGES.md") || b.hasFile("HISTORY.md")) b.convention("CHANGELOG");
  if (b.hasFile(".releaserc") || b.hasFile(".releaserc.json") || b.hasFile("release.config.js") || b.hasFile("release.config.mjs")) b.convention("semantic-release");
  if (b.hasFile("cliff.toml")) b.convention("git-cliff (Conventional Commits)");
  if (b.hasFile(".cz.toml") || b.hasFile(".czrc") || /\[tool\.commitizen\]/.test(b.text("pyproject.toml") ?? "")) b.convention("Commitizen (Conventional Commits)");
  if (b.hasFile("release-please-config.json") || b.hasFile(".release-please-manifest.json")) b.convention("release-please (Conventional Commits)");
  if (b.hasFile(".github/dependabot.yml")) b.convention("Dependabot");
  if (b.hasFile("renovate.json") || b.hasFile(".renovaterc") || b.hasFile(".github/renovate.json")) b.convention("Renovate");
  if (b.hasFile("SECURITY.md")) b.convention("SECURITY.md");
  if (b.hasFile("CODE_OF_CONDUCT.md")) b.convention("Code of Conduct");
  const license = b.first(["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "LICENSE-MIT", "LICENSE-APACHE"]);
  if (license) {
    const head = (b.text(license, 4000) ?? "").slice(0, 400);
    const name = /MIT License/i.test(head) ? "MIT" : /Apache License/i.test(head) ? "Apache-2.0" : /GNU GENERAL PUBLIC LICENSE/i.test(head) ? (/Version 3/i.test(head) ? "GPL-3.0" : "GPL-2.0") : /GNU AFFERO/i.test(head) ? "AGPL-3.0" : /GNU LESSER/i.test(head) ? "LGPL" : /Mozilla Public License/i.test(head) ? "MPL-2.0" : /BSD/i.test(head) ? "BSD" : /ISC/i.test(head) ? "ISC" : /Unlicense/i.test(head) ? "Unlicense" : /Business Source/i.test(head) ? "BUSL" : undefined;
    if (name) b.convention(`License: ${name}`);
    if (b.hasFile("LICENSE-MIT") && b.hasFile("LICENSE-APACHE")) b.convention("License: MIT OR Apache-2.0");
  }
}

// ---------------------------------------------------------------- Instruction files
const PI_LOADED = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "AGENTS.override.md"]);
const INLINE_CANDIDATES = [".cursorrules", ".github/copilot-instructions.md", ".windsurfrules", ".clinerules", "GEMINI.md", "CONVENTIONS.md", ".junie/guidelines.md", ".codex/instructions.md", "codex.md", "CODEX.md", ".continuerules", ".aider.conf.yml"];
const LIST_ONLY = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md", "DEVELOPMENT.md", "DEVELOPING.md", "HACKING.md", "ARCHITECTURE.md", "docs/ARCHITECTURE.md", "DESIGN.md", "STYLE.md", "STYLEGUIDE.md", "docs/STYLE.md", "TESTING.md", "docs/TESTING.md", "ONBOARDING.md", "MAINTAINERS.md", "GOVERNANCE.md", "ROADMAP.md", "TODO.md", "NOTES.md", "docs/README.md", "llms.txt"];

/** Files that try to steer a reviewer bot rather than describe conventions are listed but never inlined. */
export function looksLikeDirective(text: string): boolean {
  return /your only output must be|ignore (all |any )?(previous|prior|above) instructions|do not (review|summari[sz]e) (this|the)|reply with exactly|output must be exactly/i.test(text);
}

export function detectInstructions(b: Builder, opts: { inline: boolean; maxFile: number; maxTotal: number }): InstructionFile[] {
  const out: InstructionFile[] = [];
  let total = 0;
  const push = (rel: string, loadedByPi: boolean, inline: boolean) => {
    const p = join(b.root, rel);
    const text = readText(p, 200_000);
    if (text === undefined) return;
    b.fingerprintFiles.add(rel);
    const entry: InstructionFile = { path: rel, bytes: Buffer.byteLength(text), loadedByPi };
    if (inline && !loadedByPi && opts.inline && text.trim().length > 0 && text.length <= opts.maxFile && total + text.length <= opts.maxTotal) {
      if (looksLikeDirective(text)) entry.path += " (not inlined: reads like a reviewer/bot directive)";
      else {
        entry.content = text.trim();
        total += text.length;
      }
    }
    out.push(entry);
  };
  for (const f of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]) if (exists(join(b.root, f))) push(f, true, false);
  for (const f of INLINE_CANDIDATES) if (exists(join(b.root, f)) && !isDir(join(b.root, f))) push(f, PI_LOADED.has(f), true);
  // directories of rules
  for (const dir of [".cursor/rules", ".clinerules", ".roo/rules", ".windsurf/rules", ".github/instructions", ".agents/rules"]) {
    const d = join(b.root, dir);
    if (!isDir(d)) continue;
    const files = listFiles(d).filter((f) => /\.(mdc?|txt|instructions\.md)$/.test(f));
    if (files.length === 0) continue;
    // inline small "always apply" rule files, list the rest
    let inlined = 0;
    for (const f of files) {
      const rel = `${dir}/${f}`;
      const text = readText(join(d, f), 100_000) ?? "";
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      const alwaysApply = fm ? /alwaysApply:\s*true/.test(fm[1]!) : true;
      const globs = fm ? fm[1]!.match(/globs:\s*(.+)/)?.[1]?.trim() : undefined;
      const body = fm ? text.slice(fm[0].length).trim() : text.trim();
      const entry: InstructionFile = { path: rel + (globs && !alwaysApply ? ` (globs: ${clampText(globs, 60)})` : ""), bytes: Buffer.byteLength(text), loadedByPi: false };
      if (opts.inline && alwaysApply && body.length > 0 && body.length <= opts.maxFile && total + body.length <= opts.maxTotal && inlined < 6) {
        entry.content = body;
        total += body.length;
        inlined++;
      }
      out.push(entry);
      b.fingerprintFiles.add(rel);
    }
  }
  for (const f of LIST_ONLY) if (exists(join(b.root, f)) && !isDir(join(b.root, f))) push(f, false, false);
  // nested AGENTS.md in immediate subdirs (monorepo packages often carry their own)
  const nested: string[] = [];
  for (const d of listDirs(b.root).filter((d) => !d.startsWith(".") && !b.opts.ignoreDirs.includes(d)).slice(0, 40)) {
    for (const f of ["AGENTS.md", "CLAUDE.md"]) if (exists(join(b.root, d, f))) nested.push(`${d}/${f}`);
  }
  if (nested.length) b.note(`nested instruction files: ${nested.slice(0, 6).join(", ")}${nested.length > 6 ? ` (+${nested.length - 6})` : ""} — read the one for the package you touch`);
  return out;
}

// ---------------------------------------------------------------- Repo shape
export function detectRepoShape(b: Builder, gitRoot: string | undefined): { layout: string[]; remote?: string; trackedFiles?: number; name?: string; extCounts: Record<string, number>; tests?: string } {
  const extCounts: Record<string, number> = {};
  const layout: string[] = [];
  const dirs = listDirs(b.root).filter((d) => !d.startsWith(".") && !b.opts.ignoreDirs.includes(d));
  for (const d of dirs.slice(0, 14)) {
    const sub = listDirs(join(b.root, d)).filter((x) => !x.startsWith("."));
    const files = listFiles(join(b.root, d));
    const count = sub.length + files.length;
    layout.push(count > 30 ? `${d}/ (${count})` : `${d}/`);
  }
  if (dirs.length > 14) layout.push(`… +${dirs.length - 14} dirs`);
  let remote: string | undefined;
  let trackedFiles: number | undefined;
  let tests: string | undefined;
  if (gitRoot) {
    const cfg = readText(join(gitRoot, ".git", "config"), 64_000);
    if (cfg) {
      const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
      if (m) remote = normalizeRemote(m[1]!);
    } else {
      // worktree: .git is a file
      const r = spawnSync("git", ["-C", gitRoot, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0) remote = normalizeRemote(r.stdout.trim());
    }
    const ls = spawnSync("git", ["-C", b.root, "ls-files", "-z"], { encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
    if (ls.status === 0) {
      const files = ls.stdout.split("\0");
      trackedFiles = files.length - 1;
      tests = testConventions(files);
      for (const f of files) {
        const dot = f.lastIndexOf(".");
        const slash = f.lastIndexOf("/");
        if (dot <= slash || dot < 0) continue;
        const e = f.slice(dot).toLowerCase();
        if (e.length > 8) continue;
        extCounts[e] = (extCounts[e] ?? 0) + 1;
      }
    }
  }
  const name = remote?.split("/").slice(-1)[0] ?? undefined;
  return { layout, remote, trackedFiles, name, extCounts, tests };
}

function normalizeRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^(https?|ssh):\/\/(?:[^@]+@)?/, "")
    .replace(/\.git$/, "");
}

// ---------------------------------------------------------------- Services (compose, env templates, databases)
export function detectServices(b: Builder): void {
  const compose = b.first(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.dev.yml", "docker/docker-compose.yml"]);
  if (compose) {
    const svcs = composeServices(b.text(compose));
    if (svcs.length) b.add(`compose services: ${svcs.slice(0, 8).join(", ")}${svcs.length > 8 ? "…" : ""} (${compose})`);
    else b.add(`Docker Compose (${compose})`);
  }
  const envTemplate = b.first([".env.example", ".env.sample", ".env.template", ".env.dist", "env.example"]);
  if (envTemplate) b.note(`env template: ${envTemplate}`);
  if (b.hasFile("prisma/schema.prisma")) b.add("Prisma migrations (prisma/migrations)");
  if (b.hasDir("migrations") && !b.stack.some((s) => /migrations/.test(s))) b.add("migrations/ directory");
  if (b.hasDir("supabase/migrations")) b.add("Supabase migrations");
  if (b.first(["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"])) b.add("Drizzle Kit");
  if (b.hasDir("db/migrate")) b.service("ActiveRecord migrations");
  if (b.hasFile("alembic.ini")) b.service("Alembic migrations");
  if (b.hasDir("graphql") || b.rootFiles(/\.graphql$/).length || b.hasFile("schema.graphql")) b.add("GraphQL schema");
  if (b.hasDir("proto") || b.rootFiles(/\.proto$/).length) b.add("Protobuf definitions");
  if (b.hasFile("openapi.yaml") || b.hasFile("openapi.json") || b.hasFile("swagger.yaml")) b.add("OpenAPI spec");
}

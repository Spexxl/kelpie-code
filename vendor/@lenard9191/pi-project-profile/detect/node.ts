import { basename, dirname, join } from "node:path";
import { expandDirGlob, hasNodeModules, isFile, readJson, relTo, uniq } from "../fs-utils.ts";
import { NODE_BIN_PREFIX } from "../types.ts";
import { scopeFromScript } from "../verify/scope.ts";
import type { Builder } from "./context.ts";
import { parseToolVersions } from "./context.ts";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  volta?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const FRAMEWORKS: Array<[dep: string, label: string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["vue", "Vue"],
  ["react-native", "React Native"],
  ["expo", "Expo"],
  ["react", "React"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["astro", "Astro"],
  ["@remix-run/react", "Remix"],
  ["react-router", "React Router"],
  ["@tanstack/react-query", "TanStack Query"],
  ["@tanstack/react-router", "TanStack Router"],
  ["gatsby", "Gatsby"],
  ["electron", "Electron"],
  ["@tauri-apps/api", "Tauri"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["hono", "Hono"],
  ["koa", "Koa"],
  ["@nestjs/core", "NestJS"],
  ["@hapi/hapi", "Hapi"],
  ["elysia", "Elysia"],
  ["@trpc/server", "tRPC"],
  ["graphql", "GraphQL"],
  ["@apollo/server", "Apollo Server"],
  ["prisma", "Prisma"],
  ["@prisma/client", "Prisma"],
  ["drizzle-orm", "Drizzle"],
  ["typeorm", "TypeORM"],
  ["mongoose", "Mongoose"],
  ["sequelize", "Sequelize"],
  ["knex", "Knex"],
  ["kysely", "Kysely"],
  ["tailwindcss", "Tailwind"],
  ["@mui/material", "MUI"],
  ["@chakra-ui/react", "Chakra UI"],
  ["@radix-ui/react-dialog", "Radix UI"],
  ["zod", "Zod"],
  ["valibot", "Valibot"],
  ["storybook", "Storybook"],
  ["@storybook/react", "Storybook"],
  ["vite", "Vite"],
  ["webpack", "webpack"],
  ["rollup", "Rollup"],
  ["esbuild", "esbuild"],
  ["tsup", "tsup"],
  ["@swc/core", "SWC"],
  ["turbo", "Turborepo"],
  ["nx", "Nx"],
  ["lerna", "Lerna"],
  ["typescript", "TypeScript"],
  ["@playwright/test", "Playwright"],
  ["cypress", "Cypress"],
  ["puppeteer", "Puppeteer"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["ava", "AVA"],
  ["tap", "node-tap"],
  ["uvu", "uvu"],
  ["oxlint", "oxlint"],
  ["tsx", "tsx"],
  ["ts-node", "ts-node"],
  ["nodemon", "nodemon"],
  ["pm2", "PM2"],
];

const WATCH_RE = /(^|\s)(-w|--watch|--watchAll|watch)(\s|$)/;
const MUTATING_RE = /(^|\s)(--fix|--write|-w\b|--apply|--apply-unsafe)(\s|$)/;
/** Script bodies that fan out over every workspace package. */
const WORKSPACE_WIDE_RE = /(^|\s)(turbo|nx|lerna|rush|moon|wsrun|ultra)(\s|$)|(^|\s)pnpm\s+(-r|--recursive|-w|--filter|-F)\b|(^|\s)(npm|yarn)\s+.*(--workspaces|-ws\b|workspaces foreach)|(^|\s)bun\s+run\s+--filter|(^|\s)tsc\s+(-b|--build)\b/;

interface WorkspaceContext {
  root: string;
  pm: "npm" | "pnpm" | "yarn" | "bun";
  pmVersion?: string;
  name?: string;
}

/**
 * A package inside a workspace has no lockfile of its own: walk up (bounded)
 * to the nearest ancestor that declares workspaces, a packageManager, or a
 * lockfile, so commands render with the right package manager.
 */
function findWorkspaceContext(start: string): WorkspaceContext | undefined {
  let dir = dirname(start);
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json");
    const pkg = isFile(pkgPath) ? readJson<PackageJson>(pkgPath) : undefined;
    const pmField = pkg?.packageManager?.match(/^(npm|pnpm|yarn|bun)@(\S+)/);
    let pm: WorkspaceContext["pm"] | undefined;
    if (pmField) pm = pmField[1] as WorkspaceContext["pm"];
    else if (isFile(join(dir, "pnpm-workspace.yaml")) || isFile(join(dir, "pnpm-lock.yaml"))) pm = "pnpm";
    else if (isFile(join(dir, "yarn.lock"))) pm = "yarn";
    else if (isFile(join(dir, "bun.lock")) || isFile(join(dir, "bun.lockb"))) pm = "bun";
    else if (isFile(join(dir, "package-lock.json")) || pkg?.workspaces) pm = "npm";
    if (pm) return { root: dir, pm, pmVersion: pmField?.[2]?.split("+")[0], name: pkg?.name };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function detectNode(b: Builder): void {
  if (!b.hasFile("package.json")) return;
  const pkg = b.json<PackageJson>("package.json");
  if (!pkg) {
    b.note("package.json is not valid JSON");
    return;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  const has = (d: string) => Object.hasOwn(deps, d);
  const scripts = pkg.scripts ?? {};
  const isDeno = b.hasFile("deno.json") || b.hasFile("deno.jsonc");

  // ---- package manager ----
  let pm = "npm";
  let pmVersion: string | undefined;
  const pmField = pkg.packageManager?.match(/^(npm|pnpm|yarn|bun)@(\S+)/);
  const workspace = pmField || b.hasFile("pnpm-lock.yaml") || b.hasFile("yarn.lock") || b.hasFile("bun.lock") || b.hasFile("bun.lockb") || b.hasFile("package-lock.json") ? undefined : findWorkspaceContext(b.root);
  if (pmField) {
    pm = pmField[1]!;
    pmVersion = pmField[2]!.split("+")[0];
  } else if (b.hasFile("pnpm-lock.yaml")) pm = "pnpm";
  else if (b.hasFile("yarn.lock")) pm = "yarn";
  else if (b.hasFile("bun.lock") || b.hasFile("bun.lockb")) pm = "bun";
  else if (b.hasFile("package-lock.json") || b.hasFile("npm-shrinkwrap.json")) pm = "npm";
  else if (workspace) {
    // A workspace member: inherit the workspace's package manager (its lockfile lives at the workspace root).
    pm = workspace.pm;
    pmVersion = workspace.pmVersion;
    b.add(`workspace member of ${workspace.name ?? basename(workspace.root)}`);
  } else if (isDeno) pm = "deno";
  else if (b.hasFile("bunfig.toml")) pm = "bun";
  else b.note("no lockfile found; assuming npm");
  if (pm === "yarn" && !pmVersion) {
    const rc = b.text(".yarnrc.yml");
    if (rc) pmVersion = rc.match(/yarnPath:.*?yarn-(\d+\.\d+\.\d+)/)?.[1] ?? (rc.includes("nodeLinker") ? "berry" : undefined);
    else if (b.hasFile(".yarnrc")) pmVersion = "1";
  }

  // ---- runtime versions ----
  const toolVersions = parseToolVersions(b.text(".tool-versions"));
  const nodeVersion =
    b.text(".nvmrc")?.trim() ||
    b.text(".node-version")?.trim() ||
    toolVersions["nodejs"] ||
    toolVersions["node"] ||
    pkg.volta?.node ||
    pkg.engines?.node;
  if (pm === "bun") b.runtime("bun", toolVersions["bun"] ?? pmVersion ?? "");
  b.runtime("node", nodeVersion?.replace(/^v/, ""));

  // ---- languages ----
  const ts = has("typescript") || b.hasFile("tsconfig.json") || b.hasFile("tsconfig.base.json");
  if (ts) b.lang("TypeScript");
  else b.lang("JavaScript");
  if (pkg.type === "module") b.convention("ESM (\"type\": \"module\")");

  // ---- monorepo ----
  let workspaceGlobs: string[] | undefined;
  let monoKind: string | undefined;
  const pw = b.text("pnpm-workspace.yaml");
  if (pw) {
    monoKind = "pnpm workspaces";
    workspaceGlobs = Array.from(pw.matchAll(/^\s*-\s*['"]?([^'"#\n]+)['"]?/gm)).map((m) => m[1]!.trim());
  } else if (pkg.workspaces) {
    workspaceGlobs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
    monoKind = `${pm} workspaces`;
  }
  let monoTool: string | undefined;
  if (has("turbo") || b.hasFile("turbo.json")) monoTool = "Turborepo";
  else if (has("nx") || b.hasFile("nx.json")) monoTool = "Nx";
  else if (has("lerna") || b.hasFile("lerna.json")) monoTool = "Lerna";
  else if (b.hasFile("rush.json")) monoTool = "Rush";
  else if (b.hasFile(".moon/workspace.yml")) monoTool = "moon";
  let packageCount: number | undefined;
  if (workspaceGlobs && workspaceGlobs.length > 0) {
    const dirs = uniq(workspaceGlobs.filter((g) => !g.startsWith("!")).flatMap((g) => expandDirGlob(b.root, g)));
    packageCount = dirs.filter((d) => b.hasFile(relTo(b.root, join(d, "package.json")))).length;
  }
  if (monoKind || monoTool) {
    b.add(`monorepo: ${monoKind ?? "workspaces"}${packageCount ? ` (${packageCount} packages)` : ""}${monoTool ? ` + ${monoTool}` : ""}`);
    b.monorepo = { kind: monoKind ?? "workspaces", packages: packageCount, tool: monoTool };
  }

  // ---- stack tokens ----
  b.add(`${pm}${pmVersion ? ` ${pmVersion}` : ""}`);
  const seen = new Set<string>();
  for (const [dep, label] of FRAMEWORKS) {
    if (has(dep) && !seen.has(label)) {
      seen.add(label);
      if (label === "TypeScript") continue; // covered by language
      b.add(label);
    }
  }
  if (has("react") && !has("next") && !has("react-native") && (has("vite") || has("@vitejs/plugin-react"))) b.add("Vite+React");
  if (Object.keys(scripts).some((s) => /node --test\b/.test(scripts[s]!)) && !has("vitest") && !has("jest")) b.add("node:test");
  if (pm === "bun" && Object.values(scripts).some((s) => /\bbun test\b/.test(s))) b.add("bun test");

  // ---- conventions ----
  if (b.first([".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml", "prettier.config.js", "prettier.config.mjs", "prettier.config.cjs", "prettier.config.ts"]) || (pkg as any).prettier || has("prettier")) {
    b.convention("Prettier");
  }
  const eslintConfig = b.first(["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"]);
  if (eslintConfig || (pkg as any).eslintConfig || has("eslint")) b.convention("ESLint");
  const biomeConfig = b.first(["biome.json", "biome.jsonc"]);
  if (biomeConfig || has("@biomejs/biome")) b.convention("Biome");
  if (has("stylelint")) b.convention("Stylelint");
  if (b.hasDir(".husky") || has("husky")) b.convention("Husky git hooks");
  if (has("lint-staged") || (pkg as any)["lint-staged"]) b.convention("lint-staged");
  if (has("@commitlint/cli") || b.first(["commitlint.config.js", "commitlint.config.cjs", "commitlint.config.mjs", "commitlint.config.ts", ".commitlintrc", ".commitlintrc.json", ".commitlintrc.yml"])) b.convention("Conventional Commits (commitlint)");
  if (b.hasDir(".changeset") || has("@changesets/cli")) b.convention("Changesets");
  if (has("semantic-release")) b.convention("semantic-release");
  if (pkg.private === false || (pkg.name && !pkg.private && !workspaceGlobs)) b.note("package is publishable to npm (private is not set)");

  // ---- commands (display) ----
  const run = (script: string) => (pm === "yarn" ? `yarn ${script}` : pm === "npm" ? (script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`) : `${pm} run ${script}`);
  const install = pm === "yarn" ? "yarn install" : pm === "bun" ? "bun install" : pm === "pnpm" ? "pnpm install" : b.hasFile("package-lock.json") ? "npm ci" : "npm install";
  b.command("install", install, "lockfile");

  // Script lookup with name normalisation: "test-types", "test:types", "test_types" all match "test:types".
  const norm = (n: string) => n.toLowerCase().replace(/[-_.]/g, ":");
  const byNorm = new Map<string, string>();
  for (const n of Object.keys(scripts)) if (!byNorm.has(norm(n))) byNorm.set(norm(n), n);
  const find = (names: string[], contentRe?: RegExp, usable?: (s: string) => boolean): string | undefined => {
    for (const n of names) {
      const real = byNorm.get(norm(n));
      if (real === undefined) continue;
      const body = scripts[real]!;
      if (/no test specified/.test(body)) continue;
      if (contentRe && !contentRe.test(body)) continue;
      if (usable && !usable(body)) continue;
      return real;
    }
    return undefined;
  };
  const readOnly = (body: string) => !MUTATING_RE.test(body) && !WATCH_RE.test(body);
  const notWatch = (body: string) => !WATCH_RE.test(body);
  const pick = (key: string, names: string[], contentRe?: RegExp, usable?: (s: string) => boolean): string | undefined => {
    const n = find(names, contentRe, usable);
    if (n) b.command(key, run(n), `package.json scripts.${n}`);
    return n;
  };
  const TYPECHECK_NAMES = ["typecheck", "type:check", "types", "check:types", "types:check", "tsc", "lint:types", "test:types", "lint:typescript", "typecheck:all", "check:ts", "test:typecheck", "test:tsc", "ts:check"];
  const LINT_NAMES = ["lint", "lint:check", "check:lint", "lint:all", "lint:js", "lint:ts", "lint:eslint", "eslint", "test:eslint", "test:lint", "eslint:check", "biome", "biome:check", "lint:code", "lint:src"];
  const FORMAT_CHECK_NAMES = ["format:check", "fmt:check", "prettier:check", "check:format", "check:fmt", "test:format", "test:prettier", "lint:prettier", "lint:format", "format:verify", "prettier"];
  const TEST_NAMES = ["test", "test:unit", "unit", "test:lib", "vitest", "jest", "test:all", "tests", "test:ci"];
  const typecheckScript = pick("typecheck", TYPECHECK_NAMES) ?? pick("typecheck", ["check"], /\b(tsc|svelte-check|vue-tsc|astro check|tsgo)\b/);
  const lintScript = pick("lint", LINT_NAMES) ?? (typecheckScript !== "check" ? pick("lint", ["check"], /\b(eslint|biome|oxlint|xo|standard)\b/) : undefined);
  const testScript = pick("test", TEST_NAMES);
  pick("e2e", ["test:e2e", "e2e", "test:integration", "integration", "test:browser"]);
  pick("build", ["build", "compile", "bundle", "build:all"]);
  pick("dev", ["dev", "start:dev", "serve", "develop", "watch"]);
  if (!b.commands["dev"] && scripts["start"]) b.command("run", run("start"), "package.json scripts.start");
  // Only scripts that rewrite files count as the format/fix commands (used for fix hints); `--check` scripts are checks.
  const writes = (body: string) => !/--check\b|--list-different\b|--verify-no-changes\b|(^|\s)-l(\s|$)/.test(body) && !WATCH_RE.test(body);
  pick("format", ["format:fix", "format:write", "format", "fmt", "prettier"], undefined, writes);
  pick("fix", ["lint:fix", "fix", "lint-fix", "fix:lint", "lint:write", "check:fix", "fix:all"], /--fix|--write|--apply|\bfix\b/, writes);
  pick("docs", ["docs", "docs:dev", "storybook"]);
  pick("migrate", ["migrate", "db:migrate", "prisma:migrate"]);
  pick("generate", ["generate", "codegen", "gen", "generate:all", "prisma:generate", "db:generate", "gql:codegen", "graphql:codegen", "openapi", "openapi:generate", "api:generate"], undefined, notWatch);
  if (b.hasFile("prisma/schema.prisma")) {
    b.add("Prisma schema (prisma/schema.prisma)");
    if (!b.commands["generate"]) b.command("generate", `${pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : `${pm} exec`} prisma generate`, "prisma/schema.prisma");
  }

  // ---- checks ----
  const nm = hasNodeModules(b.root);
  b.fingerprintFiles.add("node_modules"); // installing deps must refresh the profile
  const requires = { files: ["node_modules"], hint: `dependencies not installed — run \`${install}\`` };
  if (!nm) b.note(`node_modules missing — checks are skipped until \`${install}\` has run`);
  const runArgv = (script: string) => (pm === "yarn" ? ["yarn", script] : pm === "npm" ? ["npm", "run", script] : [pm, "run", script]);
  // Local binaries are resolved at run time (node_modules/.bin/<tool>, walking up) so the profile stays valid before/after install.
  const bin = (tool: string, args: string[]): { argv: string[]; cmd: string; requires: { hint: string } } => ({
    argv: [`${NODE_BIN_PREFIX}${tool}`, ...args],
    cmd: `${pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : `${pm} exec`} ${tool} ${args.join(" ")}`.trim(),
    requires: { hint: `${tool} not installed in node_modules — run \`${install}\`` },
  });
  const tsExts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".json"];

  // typecheck: prefer a usable script; else the raw tool
  // Scripts that fan out over the workspace make package-level runs of the same label redundant.
  const wide = (body: string | undefined) => (body !== undefined && !!workspaceGlobs && WORKSPACE_WIDE_RE.test(body)) || undefined;
  const tcCheck = find(TYPECHECK_NAMES, undefined, notWatch) ?? find(["check"], /\b(tsc|svelte-check|vue-tsc|astro check|tsgo)\b/, notWatch);
  if (tcCheck) {
    b.check({ id: "node:typecheck", tier: "fast", label: "typecheck", cmd: run(tcCheck), argv: runArgv(tcCheck), source: `package.json scripts.${tcCheck}`, exts: tsExts, requires, tool: "tsc", coversWorkspace: wide(scripts[tcCheck]) });
  } else if (ts && (b.hasFile("tsconfig.json") || b.hasFile("tsconfig.base.json"))) {
    const tsconfig = b.hasFile("tsconfig.json") ? b.json<any>("tsconfig.json") : undefined;
    const hasRefs = Array.isArray(tsconfig?.references) && tsconfig.references.length > 0;
    const hasOwnFiles = tsconfig && (tsconfig.include || tsconfig.files) && !(Array.isArray(tsconfig.files) && tsconfig.files.length === 0);
    const noEmitOk = !(tsconfig?.compilerOptions?.composite === true);
    let r: ReturnType<typeof bin> | undefined;
    let source = "tsconfig.json + typescript";
    if (has("svelte") && has("svelte-check")) [r, source] = [bin("svelte-check", ["--tsconfig", "./tsconfig.json"]), "svelte-check"];
    else if (has("vue") && has("vue-tsc")) [r, source] = [bin("vue-tsc", ["--noEmit", "-p", "tsconfig.json"]), "vue-tsc"];
    else if (has("astro")) [r, source] = [bin("astro", ["check"]), "astro check"];
    else if (hasRefs && !hasOwnFiles) [r, source] = [bin("tsc", ["-b", "--noEmit"]), "tsconfig.json project references"];
    // A workspace root's tsconfig without include/files/references is the base config the packages extend, not a
    // project: `tsc -p` there compiles every package with the base options and reports thousands of bogus errors.
    else if (workspaceGlobs && tsconfig && !hasOwnFiles) b.note("root tsconfig.json has no include/files/references — typecheck runs per package");
    else if (b.hasFile("tsconfig.json")) r = bin("tsc", noEmitOk ? ["--noEmit", "-p", "tsconfig.json"] : ["-b"]);
    if (r) {
      b.check({ id: "node:typecheck", tier: "fast", label: "typecheck", cmd: r.cmd, argv: r.argv, source, exts: tsExts, requires: r.requires, tool: "tsc", coversWorkspace: (!!workspaceGlobs && hasRefs && !hasOwnFiles) || undefined });
      if (!b.commands["typecheck"]) b.command("typecheck", r.cmd, source);
    }
  }
  if (typecheckScript && !tcCheck) b.note(`scripts.${typecheckScript} runs in watch mode; not used as a check`);

  // lint: usable script, else biome/eslint on changed files
  const lintCheck = find(LINT_NAMES, undefined, readOnly) ?? (tcCheck !== "check" ? find(["check"], /\b(eslint|biome|oxlint|xo|standard)\b/, readOnly) : undefined);
  if (lintCheck) {
    b.check({ id: "node:lint", tier: "lint", label: "lint", cmd: run(lintCheck), argv: runArgv(lintCheck), source: `package.json scripts.${lintCheck}`, exts: tsExts.concat([".css", ".scss", ".md", ".yml", ".yaml"]), requires, tool: /biome/.test(scripts[lintCheck]!) ? "biome" : "eslint", coversWorkspace: wide(scripts[lintCheck]) });
  } else if (biomeConfig || has("@biomejs/biome")) {
    const r = bin("biome", ["check", "--no-errors-on-unmatched", "--reporter=summary"]);
    b.check({ id: "node:lint", tier: "lint", label: "lint", cmd: `${r.cmd} <files>`, argv: r.argv, appendFiles: true, unscopedArgs: ["."], source: biomeConfig ?? "@biomejs/biome", exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css"], requires: r.requires, tool: "biome" });
  } else if (eslintConfig || (pkg as any).eslintConfig) {
    const r = bin("eslint", ["--no-warn-ignored", "--max-warnings=1000000"]);
    b.check({ id: "node:lint", tier: "lint", label: "lint", cmd: `${r.cmd} <files>`, argv: r.argv, appendFiles: true, unscopedArgs: ["."], source: eslintConfig ?? "package.json eslintConfig", exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"], requires: r.requires, tool: "eslint" });
  }
  if (lintScript && !lintCheck && MUTATING_RE.test(scripts[lintScript]!)) b.note(`scripts.${lintScript} auto-fixes (--fix/--write); not used as a check`);

  // format --check as a lint-tier check
  const fmtCheck = find(FORMAT_CHECK_NAMES, /--check|--list-different|-l\b|--test|--dry-run|check/, readOnly) ?? find(["format", "fmt"], /--check|--list-different/, readOnly);
  if (fmtCheck) {
    b.check({ id: "node:format-check", tier: "lint", label: "format", cmd: run(fmtCheck), argv: runArgv(fmtCheck), source: `package.json scripts.${fmtCheck}`, exts: tsExts.concat([".css", ".scss", ".md", ".yml", ".yaml", ".html"]), requires, tool: /biome/.test(scripts[fmtCheck]!) ? "biome" : "prettier", coversWorkspace: wide(scripts[fmtCheck]) });
  } else if (b.conventions.includes("Prettier") && !lintCheck?.includes("prettier")) {
    const r = bin("prettier", ["--check", "--ignore-unknown"]);
    b.check({ id: "node:format-check", tier: "lint", label: "format", cmd: `${r.cmd} <files>`, argv: r.argv, appendFiles: true, unscopedArgs: ["."], source: "prettier config", exts: tsExts.concat([".css", ".scss", ".md", ".yml", ".yaml", ".html"]), requires: r.requires, tool: "prettier" });
  }

  // tests
  const runner = has("vitest") ? "vitest" : has("jest") ? "jest" : has("mocha") ? "mocha" : has("ava") ? "ava" : has("tap") ? "tap" : undefined;
  const testCheck = find(TEST_NAMES, undefined, notWatch);
  // Scoped form (vitest related / jest --findRelatedTests) when the script is a plain runner invocation.
  const scopeOf = (body: string) => scopeFromScript(body, (t) => `${NODE_BIN_PREFIX}${t}`, (t) => bin(t, []).cmd);
  if (testCheck) {
    const body = scripts[testCheck]!;
    b.check({ id: "node:test", tier: "test", label: "test", cmd: run(testCheck), argv: runArgv(testCheck), source: `package.json scripts.${testCheck}`, requires, tool: runner ?? "generic", env: { CI: "true" }, scope: scopeOf(body), coversWorkspace: wide(body) });
  } else if (runner === "vitest") {
    const r = bin("vitest", ["run"]);
    b.check({ id: "node:test", tier: "test", label: "test", cmd: r.cmd, argv: r.argv, source: "vitest", requires: r.requires, tool: "vitest", env: { CI: "true" }, scope: scopeOf("vitest run") });
  } else if (runner === "jest") {
    const r = bin("jest", []);
    b.check({ id: "node:test", tier: "test", label: "test", cmd: r.cmd, argv: r.argv, source: "jest", requires: r.requires, tool: "jest", env: { CI: "true" }, scope: scopeOf("jest") });
  }
  if (testScript && !testCheck) b.note(`scripts.${testScript} runs in watch mode; not used as a check`);
  // One test at a time: faster iteration than the whole suite.
  const pmx = pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : `${pm} exec`;
  const scriptsUse = (re: RegExp) => Object.values(scripts).some((body) => re.test(body));
  const one =
    runner === "vitest" ? `${pmx} vitest run <file> -t "<name>"`
    : runner === "jest" ? `${pmx} jest <file> -t "<name>"`
    : runner === "mocha" ? `${pmx} mocha <file> -g "<name>"`
    : runner === "ava" ? `${pmx} ava <file> --match "<name>"`
    : pm === "bun" && scriptsUse(/\bbun test\b/) ? `bun test <file> -t "<name>"`
    : scriptsUse(/\bnode --test\b/) ? `node --test --test-name-pattern="<name>" <file>`
    : undefined;
  if (one && (testCheck || runner)) b.command("test:one", one, runner ?? "test script");

  // build tier (confirm-once)
  const buildCheck = find(["build"], undefined, notWatch);
  if (buildCheck) {
    b.check({ id: "node:build", tier: "build", label: "build", cmd: run(buildCheck), argv: runArgv(buildCheck), source: `package.json scripts.${buildCheck}`, requires, tool: "generic", coversWorkspace: wide(scripts[buildCheck]) });
  }

  // syntax: node --check for plain JS
  b.check({ id: "node:syntax", tier: "syntax", label: "syntax", cmd: "node --check <files>", argv: [process.execPath, "--check"], appendFiles: true, source: "node", exts: [".js", ".mjs", ".cjs"], tool: "node", requires: {} });
}


/**
 * Scoped test runs: narrow a test-tier check to the tests related to the
 * changed files when the runner supports it.
 *
 *   vitest   vitest related --run --passWithNoTests <files>
 *   jest     jest --findRelatedTests --passWithNoTests --ci <files>
 *   go       go test ./<pkg>/... for each changed package
 *   cargo    cargo test -p <package> for the packages the changed files belong to
 *            (workspace members have their own manifest, so the planner already
 *            routes their files to the member's own profile and cwd; this branch
 *            matters for a workspace root that is itself a package)
 *   pytest   pytest <files> when only test files changed
 *   cargo-check  plain `cargo check` unless a test/bench/example target (or
 *            #[cfg(test)] code) changed, in which case --all-targets stays
 *
 * Every rule fails to the full run: a config or manifest change, a file kind
 * the runner cannot trace, or an ambiguous package mapping returns undefined.
 */
import { basename, dirname, join } from "node:path";
import { tomlHasTable, tomlSections } from "../detect/context.ts";
import { ext, readText, uniq } from "../fs-utils.ts";
import type { Check, ScopeSpec } from "../types.ts";

export interface Scoped {
  argv: string[];
  cmd: string;
}

const JS_SRC = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);
/** Files whose change invalidates any "related tests" reasoning. */
const JS_CONFIG_RE = /(^|[.-])config\.[cm]?[jt]sx?$|^tsconfig[^/]*\.json$|^package\.json$|^vitest\.workspace\.|^jest\.config|^\.babelrc|^babel\.config|^setup[^/]*\.[cm]?[jt]s$/i;
const PY_TEST_RE = /^test_.*\.py$|.*_test\.py$/;

/** Flags that must not survive into a partial run (coverage thresholds, watch, sharding, change detection). */
const DROP_JS_FLAGS = /^(--coverage|--watch|-w$|--watchAll|--ui$|--changed|--related|--shard|--run$|--onlyChanged|-o$|--changedSince|--findRelatedTests|--passWithNoTests|--lastCommit)/;

function filesDisplay(files: string[]): string {
  return files.slice(0, 4).join(" ") + (files.length > 4 ? ` (+${files.length - 4})` : "");
}

/**
 * Derive a ScopeSpec from a package.json test script body, or undefined when the
 * script is anything but a plain `vitest [run] [--flags]` / `jest [--flags]`.
 * Env assignments and `cross-env` prefixes are tolerated; flags with separate
 * values (`--config x`) are not, because their meaning cannot be preserved.
 */
export function scopeFromScript(body: string, binHead: (tool: string) => string, display: (tool: string) => string): ScopeSpec | undefined {
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || tokens[0] === "cross-env" || tokens[0] === "dotenv")) tokens.shift();
  const tool = tokens.shift();
  if (tool !== "vitest" && tool !== "jest") return undefined;
  if (tool === "vitest" && tokens[0] === "run") tokens.shift();
  if (!tokens.every((t) => t.startsWith("-"))) return undefined;
  const flags = tokens.filter((t) => !DROP_JS_FLAGS.test(t));
  const args = uniq(tool === "vitest" ? ["related", "--run", "--passWithNoTests", ...flags] : ["--findRelatedTests", "--passWithNoTests", "--ci", ...flags]);
  return { kind: tool, argv: [binHead(tool), ...args], cmd: `${display(tool)} ${args.join(" ")}`.trim() };
}

/** Scoped argv/cmd for a check given changed files relative to check.cwd, or undefined for the full run. */
export function scopeCheck(check: Check, files: string[]): Scoped | undefined {
  const spec = check.scope;
  if (!spec) return undefined;
  const rel = uniq(files.map((f) => f.split("\\").join("/"))).filter((f) => f && !f.startsWith("..") && !f.startsWith("/"));
  if (rel.length === 0) return undefined;
  switch (spec.kind) {
    case "vitest":
    case "jest": {
      if (!spec.argv) return undefined;
      if (!rel.every((f) => JS_SRC.has(ext(f)) && !JS_CONFIG_RE.test(basename(f)))) return undefined;
      return { argv: [...spec.argv, ...rel], cmd: `${spec.cmd ?? spec.argv.join(" ")} ${filesDisplay(rel)}` };
    }
    case "go": {
      if (!rel.every((f) => ext(f) === ".go")) return undefined;
      const pkgs = uniq(rel.map((f) => dirname(f)));
      if (pkgs.includes(".")) return undefined; // root package → ./... is the full run anyway
      const targets = pkgs.sort().map((p) => `./${p}/...`);
      return { argv: ["go", "test", ...targets], cmd: `go test ${targets.join(" ")}` };
    }
    case "cargo": {
      const root = readText(join(check.cwd, "Cargo.toml"));
      if (!root || !tomlHasTable(root, "workspace")) return undefined; // single crate: nothing to narrow
      const members = new Set<string>();
      for (const f of rel) {
        const base = basename(f);
        if (base === "Cargo.lock" || f === "Cargo.toml") return undefined; // workspace manifest/lock → full run
        const manifestDir = nearestManifestDir(check.cwd, dirname(f));
        if (manifestDir === undefined) return undefined;
        // "." is the workspace root: only meaningful when the root is a package itself.
        const name = tomlSections(manifestDir === "." ? root : readText(join(check.cwd, manifestDir, "Cargo.toml"))).get("package")?.["name"];
        if (!name) return undefined;
        members.add(name);
      }
      if (members.size === 0) return undefined;
      const flags = Array.from(members).sort().flatMap((m) => ["-p", m]);
      return { argv: [...check.argv, ...flags], cmd: `cargo test ${flags.join(" ")}` };
    }
    case "pytest": {
      if (!rel.every((f) => ext(f) === ".py" && PY_TEST_RE.test(basename(f)))) return undefined;
      return { argv: [...check.argv, ...rel], cmd: `${check.cmd} ${filesDisplay(rel)}` };
    }
    case "cargo-check": {
      // Test/bench/example targets only compile with --all-targets; so does #[cfg(test)] code in library sources.
      const needsAll = rel.some((f) => {
        if (ext(f) !== ".rs") return true; // Cargo.toml / build.rs etc.: keep the full form
        if (/^(tests|benches|examples)\//.test(f) || /\/(tests|benches|examples)\//.test(f)) return true;
        const src = readText(join(check.cwd, f), 512 * 1024) ?? "";
        return /#\[\s*cfg\s*\(\s*test\s*\)\s*\]|#\[\s*test\s*\]|#\[\s*bench\s*\]/.test(src);
      });
      if (needsAll) return undefined;
      return { argv: check.argv.filter((a) => a !== "--all-targets"), cmd: check.cmd.replace(" --all-targets", "") };
    }
    default:
      return undefined;
  }
}

/** Nearest directory (relative, "." for cwd) at or above `dir` containing a Cargo.toml; undefined when none up to cwd. */
function nearestManifestDir(cwd: string, dir: string): string | undefined {
  let cur = dir === "" ? "." : dir;
  for (let i = 0; i < 32; i++) {
    if (readText(join(cwd, cur, "Cargo.toml")) !== undefined) return cur;
    if (cur === ".") return undefined;
    const parent = dirname(cur);
    cur = parent === "" ? "." : parent;
  }
  return undefined;
}

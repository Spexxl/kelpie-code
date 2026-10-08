/**
 * `/profile doctor`: why checks can or cannot run here. Compares required
 * runtime versions with what is on PATH, checks tool and dependency
 * availability, and prints the commands that would fix it. Read-only: it
 * runs `--version` probes and nothing else.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tildify } from "../fs-utils.ts";
import { checkKey, type Check, type StoredProfile } from "../types.ts";
import { availability, effectiveCommands } from "./render.ts";

type V = [number, number, number];

function parseVersion(s: string): V | undefined {
  const m = s.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

function cmp(a: V, b: V): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Does `version` satisfy `range`? Supports the forms projects actually use:
 * exact/partial versions (22, 3.12, 1.80.1: same major, and minor when given),
 * >=, >, <=, <, ^, ~, ~=, x/* wildcards, space-separated AND and || OR.
 * Undefined when the range cannot be evaluated (lts/*, stable, nightly…).
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) return undefined;
  const alts = range.split("||").map((s) => s.trim()).filter(Boolean);
  if (alts.length === 0) return undefined;
  let known = false;
  for (const alt of alts) {
    const parts = alt.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    let ok = true;
    let understood = true;
    for (const p of parts) {
      const m = p.match(/^(>=|<=|>|<|\^|~=|~|=|==|v)?\s*(\d+(?:\.(?:\d+|x|\*))*)(?:[.-][\w.]*)?$/i);
      if (!m) {
        understood = false;
        break;
      }
      const op = (m[1] ?? "").toLowerCase();
      const raw = m[2]!;
      const segs = raw.split(".");
      const wild = segs.findIndex((s) => s === "x" || s === "*");
      const given = wild === -1 ? segs.length : wild;
      const r = parseVersion(segs.slice(0, given).join(".") || "0")!;
      switch (op) {
        case ">=":
          ok &&= cmp(v, r) >= 0;
          break;
        case ">":
          ok &&= cmp(v, r) > 0;
          break;
        case "<=":
          ok &&= cmp(v, r) <= 0;
          break;
        case "<":
          ok &&= cmp(v, r) < 0;
          break;
        case "^":
          ok &&= cmp(v, r) >= 0 && (r[0] > 0 ? v[0] === r[0] : v[1] === r[1]);
          break;
        case "~":
          ok &&= cmp(v, r) >= 0 && v[0] === r[0] && (given < 2 || v[1] === r[1]);
          break;
        case "~=":
          ok &&= cmp(v, r) >= 0 && v[0] === r[0] && (given < 3 || v[1] === r[1]);
          break;
        default:
          // bare / = / v: match the components that were given
          ok &&= v[0] === r[0] && (given < 2 || v[1] === r[1]) && (given < 3 || v[2] === r[2]);
      }
    }
    if (!understood) continue;
    known = true;
    if (ok) return true;
  }
  return known ? false : undefined;
}

function probe(cmd: string, args: string[], cwd: string): string | undefined {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 5000, shell: process.platform === "win32" });
    if (r.status !== 0) return undefined;
    return `${r.stdout} ${r.stderr}`.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

interface RuntimeSpec {
  name: string;
  probe: [string, string[]];
  /** go.mod `go 1.22` and rust-version are minimums, not exact pins. */
  minimum?: boolean;
  hint: string;
}

const RUNTIMES: Record<string, RuntimeSpec> = {
  node: { name: "node", probe: ["node", ["--version"]], hint: "switch Node with nvm/fnm/volta/mise (e.g. `nvm use`)" },
  python: { name: "python", probe: ["python3", ["--version"]], hint: "use pyenv/uv (`uv python install <version>`) or activate the project venv" },
  go: { name: "go", probe: ["go", ["version"]], minimum: true, hint: "install a newer Go (or let GOTOOLCHAIN download it)" },
  rust: { name: "rust", probe: ["rustc", ["--version"]], hint: "rustup installs the pinned toolchain automatically" },
  bun: { name: "bun", probe: ["bun", ["--version"]], hint: "`bun upgrade`" },
};

/** Markdown report. */
export function doctorReport(stored: StoredProfile, checks: Check[], broken: Map<string, string>): string {
  const d = stored.detected;
  const out: string[] = [`# /profile doctor — ${d.name ?? d.root}`, ""];
  const fixes: string[] = [];
  out.push("## Runtimes");
  const rts = Object.entries(d.runtimes);
  if (rts.length === 0) out.push("- (no runtime requirements detected)");
  for (const [name, required] of rts) {
    const spec = RUNTIMES[name];
    if (!spec) {
      out.push(`- ${name}: requires \`${required}\``);
      continue;
    }
    const found = probe(spec.probe[0], spec.probe[1], d.root);
    if (!found) {
      out.push(`- ✗ ${name}: requires \`${required}\`, but \`${spec.probe[0]}\` is not on PATH`);
      fixes.push(`install ${name} ${required}`);
      continue;
    }
    const version = found.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? found;
    const range = required.replace(/^≥/, ">=");
    const ok = satisfies(version, spec.minimum && /^\d/.test(range) ? `>=${range}` : range);
    if (ok === false) {
      out.push(`- ⚠ ${name}: requires \`${required}\`, found ${version} — ${spec.hint}`);
      fixes.push(`${name} ${required} (found ${version})`);
    } else out.push(`- ${ok ? "✓" : "·"} ${name}: requires \`${required}\`, found ${version}${ok === undefined ? " (range not checked)" : ""}`);
  }
  out.push("", "## Checks");
  if (checks.length === 0) out.push("- (none detected)");
  for (const c of checks) {
    const where = c.cwd === d.root ? "" : ` · in ${tildify(c.cwd)}`;
    const disabled = broken.get(checkKey(c));
    const missing = availability(c);
    if (disabled) out.push(`- ⚠ ${c.label} \`${c.cmd}\`${where} — disabled this session: ${disabled}`);
    else if (missing) {
      out.push(`- ✗ ${c.label} \`${c.cmd}\`${where} — ${missing}`);
      const cmd = missing.match(/`([^`]+)`/)?.[1];
      if (cmd) fixes.push(cmd);
    } else out.push(`- ✓ ${c.label} \`${c.cmd}\`${where}`);
  }
  out.push("", "## Dependencies");
  const cmds = effectiveCommands(stored);
  const install = cmds["install"]?.cmd;
  const langs = d.languages.join(" ");
  let depLines = 0;
  if (/TypeScript|JavaScript/.test(langs) && existsSync(join(d.root, "package.json"))) {
    const nm = findUp(d.root, "node_modules");
    out.push(nm ? `- ✓ node_modules (${tildify(nm)})` : `- ✗ node_modules missing${install ? ` — run \`${install}\`` : ""}`);
    if (!nm && install) fixes.push(install);
    depLines++;
  }
  if (/Python/.test(langs)) {
    const venv = [".venv", "venv"].find((v) => existsSync(join(d.root, v)));
    const runner = /^(uv|poetry|pdm|pipenv|hatch) /.exec(install ?? "")?.[1];
    if (venv) out.push(`- ✓ virtualenv ${venv}/`);
    else if (runner) out.push(`- · no local venv; \`${runner}\` manages the environment${install ? ` (\`${install}\`)` : ""}`);
    else out.push(`- ⚠ no virtualenv found${install ? ` — \`${install}\`` : ""}`);
    depLines++;
  }
  if (existsSync(join(d.root, "composer.json"))) {
    out.push(existsSync(join(d.root, "vendor")) ? "- ✓ vendor/" : "- ✗ vendor/ missing — run `composer install`");
    depLines++;
  }
  if (depLines === 0) out.push("- (nothing to check)");
  out.push("", "## Fix");
  if (fixes.length === 0) out.push("Nothing to fix: every detected check can run.");
  else {
    out.push("Not run automatically (installs and toolchain changes are yours to make):");
    for (const f of Array.from(new Set(fixes))) out.push(`- \`${f}\``);
  }
  return out.join("\n");
}

function findUp(start: string, name: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

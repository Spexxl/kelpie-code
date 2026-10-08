/**
 * Late binding of check executables. Detection must not depend on whether
 * dependencies are installed *right now* (the profile is cached), so argv[0]
 * may be a virtual reference resolved at run time:
 *
 *   node_modules/.bin:<tool>      nearest node_modules/.bin/<tool> walking up from cwd
 *   python:<manager>:<tool>       manager runner (uv/poetry/pdm/pipenv/hatch) → venv bin → PATH
 */
import { join } from "node:path";
import { executableCandidates, findNodeBin, isExecutable, isWindows, which } from "../fs-utils.ts";
import type { Check } from "../types.ts";
import { NODE_BIN_PREFIX, PY_PREFIX } from "../types.ts";

export interface Resolved {
  argv: string[];
  missing?: string;
}

export function resolveArgv(check: Check, extraFiles: string[] = []): Resolved {
  const head = check.argv[0] ?? "";
  const rest = check.argv.slice(1);
  if (head.startsWith(NODE_BIN_PREFIX)) {
    const tool = head.slice(NODE_BIN_PREFIX.length);
    const bin = findNodeBin(check.cwd, tool);
    if (!bin) return { argv: [], missing: check.requires?.hint ?? `${tool} not installed in node_modules` };
    return { argv: [bin, ...rest, ...extraFiles] };
  }
  if (head.startsWith(PY_PREFIX)) {
    const [, manager = "pip", tool = "python"] = head.split(":");
    const r = resolvePython(check.cwd, manager, tool);
    if (!r) return { argv: [], missing: check.requires?.hint ?? `${tool} not available in this project's Python environment` };
    return { argv: [...r, ...rest, ...extraFiles] };
  }
  // plain executable: verify presence. On Windows spawn needs the resolved `.cmd`/`.exe` path (PATHEXT is not applied without a shell).
  const found = which(head);
  if (!found) return { argv: [], missing: check.requires?.hint ?? `${head} not found` };
  return { argv: [isWindows() ? found : head, ...rest, ...extraFiles] };
}

const RUNNERS: Record<string, string[]> = {
  uv: ["uv", "run", "--"],
  poetry: ["poetry", "run"],
  pdm: ["pdm", "run"],
  pipenv: ["pipenv", "run"],
  hatch: ["hatch", "run"],
};

export function resolvePython(cwd: string, manager: string, tool: string): string[] | undefined {
  const runner = RUNNERS[manager];
  if (runner && which(runner[0]!)) return [...runner, tool];
  for (const v of [".venv", "venv", "env", ".env"]) {
    for (const name of executableCandidates(tool)) {
      const bin = join(cwd, v, isWindows() ? "Scripts" : "bin", name);
      if (isExecutable(bin)) return [bin];
    }
  }
  if (tool === "python") {
    const py = which("python3") ?? which("python");
    return py ? [py] : undefined;
  }
  const onPath = which(tool);
  if (onPath) return [onPath];
  // `python -m <tool>` when the module is importable is not checked here; PATH is the contract.
  return undefined;
}

/** Human-readable display prefix for a python tool given the manager. */
export function pythonDisplay(manager: string, tool: string): string {
  const runner = RUNNERS[manager];
  return runner ? `${runner.filter((x) => x !== "--").join(" ")} ${tool}` : tool;
}

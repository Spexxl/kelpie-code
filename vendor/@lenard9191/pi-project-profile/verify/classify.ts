/**
 * Decide whether a failed check failed because of the code (send the agent
 * back) or because of the environment (tell the user, disable for the session).
 */
import type { RunResult } from "./run.ts";

const ENV_PATTERNS: Array<[RegExp, string]> = [
  [/command not found|not found: [\w.-]+|No such file or directory.*(bin|exec)|is not recognized as an internal/i, "command not found"],
  [/\bENOENT\b.*spawn|spawn .* ENOENT/i, "executable not found"],
  [/\bEACCES\b|Permission denied/i, "permission denied"],
  [/npm (ERR!|error) (Missing script|missing script)|ERR_PNPM_NO_SCRIPT|error Command ".*" not found|Script not found "|error: no such command|Unknown command|No such task|no such task/i, "script/task does not exist"],
  [/Cannot find module '(typescript|vitest|jest|eslint|@biomejs|prettier|tsx|ts-node|mocha|ava|vue-tsc|svelte-check)/i, "tool dependency not installed"],
  [/Cannot find module '\S+'\s*\n\s*Require stack:\s*\n\s*- \S*node_modules\/\.bin/i, "tool dependency not installed"],
  [/ModuleNotFoundError: No module named '(pytest|mypy|ruff|pyright|black|isort|flake8|pylint|django)'/i, "python tool not installed"],
  [/No module named (pytest|mypy|ruff|pyright|black|isort|flake8)\b/i, "python tool not installed"],
  [/could not find `Cargo\.toml`|error: no such command: `?(clippy|fmt)|error: 'cargo-clippy' is not installed|rustfmt' is not installed|toolchain '.*' is not installed|error: the '\S+' component/i, "cargo component or manifest missing"],
  [/go: cannot find main module|go: go\.mod file not found|go: updates to go\.mod needed|missing go\.sum entry/i, "go module setup needed (go mod tidy / go mod download)"],
  [/Unchecked dependencies|dependency .* is not available|run "mix deps\.get"/i, "elixir deps not fetched (mix deps.get)"],
  [/Please run "terraform init"|terraform init|Backend initialization required|Required plugins are not installed/i, "terraform not initialised"],
  [/Could not find gem|Bundler could not find compatible versions|bundler: command not found|Run `bundle install`/i, "gems not installed (bundle install)"],
  [/vendor\/autoload\.php.*(No such file|failed to open)|Composer autoloader not found|Please run 'composer install'/i, "composer deps not installed"],
  [/Could not resolve all (files|dependencies)|Could not GET '|Could not download|UnknownHostException|Connection refused|Network is unreachable|getaddrinfo ENOTFOUND|Temporary failure in name resolution|dial tcp.*: connect/i, "network or dependency resolution failure"],
  [/JAVA_HOME|No Java runtime present|Unable to locate a Java Runtime/i, "java runtime missing"],
  [/error: option '?--noEmit'? cannot be specified with|TS5053|TS6053: File .* not found|TS5058|TS5083|error TS5023|error TS5024|error TS6046/i, "typescript configuration/invocation problem"],
  [/The tsconfig\.json file .* not found|tsconfig\.json.* does not exist/i, "tsconfig missing"],
  [/error: unknown option|error: unrecognized (option|argument|subcommand)|unexpected argument|invalid option|unknown flag|flag provided but not defined|Unknown option/i, "unsupported flag for this tool version"],
  [/pnpm: Command failed.*\n.*ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT|None of the selected packages has a "\w+" script/i, "script does not exist in workspace"],
  [/Xcode.*(not installed|license)|xcode-select/i, "xcode setup needed"],
  [/error: could not find native static library|pkg-config.*not found|library not found for -l|could not find system library/i, "system library missing"],
  [/OSError: \[Errno 28\]|No space left on device/i, "disk full"],
  [/Killed|out of memory|OOM/i, "process killed (memory?)"],
  [/database .* does not exist|could not connect to server|ECONNREFUSED|Connection refused|Redis connection|MongoServerSelectionError|password authentication failed|Access denied for user/i, "required service not running (database/cache)"],
  [/env var|environment variable .* (is )?(not set|required|missing)|Missing required env|dotenv.*not found/i, "missing environment variable"],
];

export interface Classification {
  kind: "code" | "env";
  reason?: string;
}

export function classifyFailure(result: RunResult, opts: { diagnosticCount: number; combined: string }): Classification {
  if (result.spawnError) return { kind: "env", reason: `could not start process: ${result.spawnError}` };
  if (result.timedOut) return { kind: "env", reason: "timed out" };
  if (result.code === 127 || result.code === 126) return { kind: "env", reason: "command not found / not executable" };
  const head = opts.combined.slice(0, 6000);
  const tail = opts.combined.slice(-6000);
  const sample = head + "\n" + tail;
  // A run that produced real diagnostics is a code failure even if the log also mentions e.g. "Connection refused" in a test.
  if (opts.diagnosticCount >= 2) {
    // …unless the diagnostics themselves are the env problem (tool missing).
    for (const [re, reason] of ENV_PATTERNS.slice(0, 12)) if (re.test(head.slice(0, 1500))) return { kind: "env", reason };
    return { kind: "code" };
  }
  for (const [re, reason] of ENV_PATTERNS) if (re.test(sample)) return { kind: "env", reason };
  return { kind: "code" };
}

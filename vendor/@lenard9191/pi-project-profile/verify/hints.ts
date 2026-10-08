/**
 * Auto-fix hints for failing format/lint checks: the exact command that
 * rewrites the offending files, derived from the check's own command. The
 * agent runs it itself (visible, its own action); the harness never does.
 */
import type { Check, CommandInfo } from "../types.ts";

type Rule = [test: RegExp, fix: (cmd: string) => string];

/** Ordered: first match wins. Each rule turns a read-only invocation into its writing counterpart. */
const RULES: Rule[] = [
  [/\bprettier\b.*--check\b/, (c) => c.replace(/--check\b/, "--write")],
  [/\bprettier\b.*--list-different\b/, (c) => c.replace(/--list-different\b/, "--write")],
  [/\bbiome (check|lint|format)\b/, (c) => c.replace(/--reporter=\S+\s*/, "").replace(/\bbiome (check|lint|format)\b/, (m) => `${m} --write`)],
  [/\beslint\b/, (c) => c.replace(/--max-warnings[= ]\S+\s*/, "").replace(/\beslint\b/, "eslint --fix")],
  [/\bruff check\b/, (c) => c.replace(/--no-fix\s*/, "").replace(/--output-format[= ]\S+\s*/, "").replace(/\bruff check\b/, "ruff check --fix")],
  [/\bruff format\b.*--check\b/, (c) => c.replace(/--check\s*/, "").replace(/--diff\s*/, "")],
  [/\bblack\b.*--check\b/, (c) => c.replace(/--check\s*/, "").replace(/--diff\s*/, "").replace(/--quiet\s*/, "")],
  [/\bisort\b.*--check(-only)?\b/, (c) => c.replace(/--check(-only)?\s*/, "").replace(/--diff\s*/, "")],
  [/\bgofmt -l\b/, (c) => c.replace(/\bgofmt -l\b/, "gofmt -w")],
  [/\bcargo fmt\b.*--check\b/, (c) => c.replace(/\s*--\s*--check\b|\s*--check\b/, "")],
  [/\bmix format --check-formatted\b/, (c) => c.replace(/\s*--check-formatted\b/, "")],
  [/\b(terraform|tofu) fmt -check\b/, (c) => c.replace(/\s*-check\b/, "")],
  [/\bdotnet format\b.*--verify-no-changes\b/, (c) => c.replace(/\s*--verify-no-changes\b/, "")],
  [/\bzig fmt --check\b/, (c) => c.replace(/\s*--check\b/, "")],
  [/\bdeno fmt --check\b/, (c) => c.replace(/\s*--check\b/, "")],
  [/\bdart format\b.*--set-exit-if-changed\b/, (c) => c.replace(/\s*--output=none\b/, "").replace(/\s*--set-exit-if-changed\b/, "")],
  [/\bpint --test\b/, (c) => c.replace(/\s*--test\b/, "")],
  [/\bphp-cs-fixer check\b/, (c) => c.replace(/\bphp-cs-fixer check\b/, "php-cs-fixer fix")],
  [/\bswift-format lint\b/, (c) => c.replace(/\bswift-format lint( --strict)?\b/, "swift-format format --in-place")],
  [/\brubocop\b/, (c) => (/\s-a\b|--autocorrect/.test(c) ? c : c.replace(/\brubocop\b/, "rubocop -a"))],
  [/\bswiftlint\b/, (c) => (/--fix\b/.test(c) ? c : c.replace(/\bswiftlint( lint)?\b/, "swiftlint --fix"))],
];

function quote(f: string): string {
  return /[\s"'$`\\()<>|&;*?\[\]{}]/.test(f) ? `'${f.replace(/'/g, `'\\''`)}'` : f;
}

/** `npx` / `pnpm exec` / … for the package manager a script-based check runs through. */
function execPrefix(argv0: string | undefined): string | undefined {
  switch (argv0) {
    case "npm":
      return "npx";
    case "pnpm":
      return "pnpm exec";
    case "yarn":
      return "yarn";
    case "bun":
      return "bunx";
    default:
      return undefined;
  }
}

/**
 * The fix command for a failing check, or undefined when there is no safe
 * mechanical fix. `files` are the files the check ran on (relative to its cwd),
 * or, for a project-wide check, the files the agent changed under it.
 */
export function fixHint(check: Check, files: string[] = [], commands: Record<string, CommandInfo> = {}): string | undefined {
  if (check.label !== "format" && check.label !== "lint" && check.label !== "imports") return undefined;
  const cmd = check.cmd;
  const direct = !/^(npm|pnpm|yarn|bun) (run )?\S+$/.test(cmd.trim()) && !/^(make|just|task) \S+$/.test(cmd.trim());
  const list = files.filter((f) => f && !f.startsWith("-"));
  // A project-wide format script (`prettier --check .`) fails for the agent's files: format those, never the whole tree
  // (a repo that was never formatted would get hundreds of unrelated rewrites).
  if (!direct && check.label === "format" && list.length > 0 && list.length <= 12) {
    const px = execPrefix(check.argv[0]);
    if (px && check.tool === "prettier") return `${px} prettier --write ${list.map(quote).join(" ")}`;
    if (px && check.tool === "biome") return `${px} biome format --write ${list.map(quote).join(" ")}`;
  }
  if (direct) {
    const rule = RULES.find(([re]) => re.test(cmd));
    if (!rule) return undefined;
    let fixed = rule[1](cmd).replace(/\s+/g, " ").trim();
    if (fixed.includes("<files>")) {
      if (list.length === 0 || list.length > 12) fixed = fixed.replace(/\s*<files>/, check.unscopedArgs?.length ? ` ${check.unscopedArgs.join(" ")}` : "");
      else fixed = fixed.replace("<files>", list.map(quote).join(" "));
    }
    return fixed === cmd ? undefined : fixed;
  }
  // Script-based checks (`pnpm run lint:check`): the repo's own writing script, when it has one.
  const own = check.label === "format" ? (commands["format"] ?? commands["fix"]) : (commands["fix"] ?? undefined);
  if (!own || own.cmd === cmd) return undefined;
  return own.cmd;
}

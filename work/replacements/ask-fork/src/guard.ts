import type { ModePolicy } from "./types.ts";

/**
 * Pure tool-call guard: decides whether a tool call is blocked under a mode's
 * policy. Pi has no native permission system, so this is the enforcement
 * layer for read-only modes. Kept dependency-free for unit testing.
 */

/** Built-in tools that mutate the filesystem. */
export const WRITE_TOOLS = ["edit", "write"] as const;

/**
 * Built-in tools that are read-only by construction. Used to decide whether a
 * tool is "known" when `blockUnknownTools` is enabled.
 */
export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

export const BUILTIN_TOOLS: readonly string[] = [
	...READONLY_BUILTIN_TOOLS,
	"bash",
	...WRITE_TOOLS,
];

export interface GuardRequest {
	modeName: string;
	policy: ModePolicy;
	toolName: string;
	/** Raw tool arguments (used for the bash command). */
	input: Record<string, unknown>;
}

export interface GuardDecision {
	blocked: boolean;
	reason?: string;
}

/** Build the block reason shown to the model. */
export function blockReason(modeName: string, detail: string): string {
	return `[modes] Blocked by mode "${modeName}": ${detail} Switch modes with /mode if this tool is required.`;
}

/**
 * Evaluate a tool call against a mode policy.
 * Priority: explicit allowTools → explicit blockTools → write tools → bash →
 * unknown tools.
 */
export function evaluateToolCall(request: GuardRequest): GuardDecision {
	const { modeName, policy, toolName, input } = request;

	if (policy.allowTools.includes(toolName)) return { blocked: false };

	if (policy.blockTools.includes(toolName)) {
		return { blocked: true, reason: blockReason(modeName, `tool "${toolName}" is blocked by this mode's configuration.`) };
	}

	// Built-in file mutation tools.
	if ((WRITE_TOOLS as readonly string[]).includes(toolName)) {
		if (!policy.allowWriteTools) {
			return { blocked: true, reason: blockReason(modeName, `"${toolName}" modifies files and this mode is read-only.`) };
		}
		return { blocked: false };
	}

	// Bash: deny everything, or allowlist read-only commands.
	if (toolName === "bash") {
		if (policy.bash === "deny") {
			return { blocked: true, reason: blockReason(modeName, "bash is disabled in this mode.") };
		}
		if (policy.bash === "readOnly") {
			const command = typeof input.command === "string" ? input.command : "";
			if (!isSafeBashCommand(command)) {
				return {
					blocked: true,
					reason: blockReason(
						modeName,
						`bash is restricted to read-only commands in this mode.\nBlocked command: ${command || "(empty)"}`,
					),
				};
			}
		}
		return { blocked: false };
	}

	// Unknown (custom) tools: only blocked when the policy demands strictness.
	if (policy.blockUnknownTools && !(READONLY_BUILTIN_TOOLS as readonly string[]).includes(toolName)) {
		return {
			blocked: true,
			reason: blockReason(
				modeName,
				`unknown tool "${toolName}" is blocked because blockUnknownTools is enabled. Add it to allowTools in modes.config.json to permit it.`,
			),
		};
	}

	return { blocked: false };
}

/**
 * Compute the active tool set for a mode (defense-in-depth layer 1).
 *
 * Built-in mutating tools and unknown custom tools are removed when their
 * policy requires it. Explicitly blocked tools remain visible so the
 * `tool_call` hook can return an explanatory reason instead of silently
 * hiding a configured restriction.
 */
export function filterActiveTools(
	active: readonly string[],
	policy: ModePolicy,
	customTools: ReadonlySet<string>,
): string[] {
	return active.filter((name) => {
		if (policy.allowTools.includes(name)) return true;
		if (name === "edit" || name === "write") return policy.allowWriteTools;
		if (name === "bash") return policy.bash !== "deny";
		if (policy.blockUnknownTools && customTools.has(name)) return false;
		return true;
	});
}

/**
 * Validate a bash command for read-only execution.
 *
 * This deliberately uses a small shell lexer rather than a regex allowlist.
 * The validator fails closed for shell control flow, substitutions, redirects,
 * wrappers, and commands whose flags can execute or write elsewhere. It is
 * still an extension-level policy, not an OS sandbox (see README).
 */
export function isSafeBashCommand(command: string): boolean {
	const segments = tokenizeReadOnlyShell(command);
	return segments !== undefined && segments.length > 0 && segments.every(isSafeReadOnlySegment);
}

interface ShellSegment {
	words: string[];
}

/**
 * Split a command into a pipeline while rejecting every other shell operator.
 * Quoted pipes are treated as ordinary argument characters.
 */
function tokenizeReadOnlyShell(command: string): ShellSegment[] | undefined {
	if (!command.trim()) return undefined;

	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let tokenStarted = false;

	const flushToken = (): void => {
		if (!tokenStarted) return;
		words.push(token);
		token = "";
		tokenStarted = false;
	};
	const flushSegment = (): boolean => {
		flushToken();
		if (words.length === 0) return false;
		segments.push({ words });
		words = [];
		return true;
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (character === undefined) continue;

		if (escaped) {
			token += character;
			tokenStarted = true;
			escaped = false;
			continue;
		}

		if (quote === "'") {
			if (character === "'") quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}

		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === undefined || next === "\n" || next === "\r") return undefined;
				token += next;
				tokenStarted = true;
				index++;
				continue;
			}
			// Variable and command expansion are rejected even inside double quotes.
			if (character === "$" || character === "`") return undefined;
			token += character;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(character)) {
			if (character === "\n" || character === "\r") return undefined;
			flushToken();
			continue;
		}
		if (character === "\\") {
			escaped = true;
			tokenStarted = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (character === "|") {
			if (command[index + 1] === "|") return undefined;
			if (!flushSegment()) return undefined;
			continue;
		}
		// Reject command lists, background jobs, redirections, substitutions and
		// grouping. A quoted operator never reaches this branch.
		if (";&<>$`(){}".includes(character)) return undefined;

		token += character;
		tokenStarted = true;
	}

	if (quote !== undefined || escaped || !flushSegment()) return undefined;
	return segments;
}

const READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more", "zcat", "zgrep", "zless", "gzcat",
	"grep", "rg", "ripgrep", "egrep", "fgrep", "find", "fd", "ls", "dir", "eza", "exa",
	"pwd", "realpath", "readlink", "echo", "printf", "wc", "sort", "uniq", "cut", "paste",
	"comm", "diff", "cmp", "file", "stat", "du", "df", "tree", "which", "whereis", "type",
	"uname", "whoami", "id", "hostname", "date", "cal", "uptime", "ps", "top", "htop",
	"free", "vmstat", "iostat", "ss", "netstat", "lsof", "git", "npm", "yarn", "pnpm",
	"jq", "yq", "awk", "sed", "bat", "batcat", "gpg", "direnv", "openssl", "curl", "wget",
	"python", "python3", "node", "deno", "bun", "command",
]);

const FORBIDDEN_ARGUMENTS = [
	/^(?:-i|--in-place|--delete|--exec(?:dir)?|--ok(?:dir)?|-x|--exec-batch)$/i,
	/^(?:--(?:output|output-document|remote-name|upload-file|config|data|data-raw|data-binary|data-urlencode|form|request|post-data|method|body-data))=/i,
	/^(?:-T)$/i,
	/^--(?:upload-pack|exec-path|config-env)$/i,
];

function isSafeReadOnlySegment(segment: ShellSegment): boolean {
	const [rawCommand, ...args] = segment.words;
	if (!rawCommand) return false;
	if (rawCommand.includes("/")) return false;
	const command = rawCommand.toLowerCase();
	if (!READ_ONLY_COMMANDS.has(command)) return false;
	if (args.some((argument) => FORBIDDEN_ARGUMENTS.some((pattern) => pattern.test(argument)))) return false;

	// Interpreter-like expressions and shell wrappers are not accepted. This
	// catches mutation hidden inside awk, sed, or an opaque command argument.
	const text = segment.words.join(" ");
	if (/\b(?:system|exec|eval|spawn|popen|subprocess|unlink|rename|chmod|chown)\s*[({'[]/i.test(text)) return false;
	if (args.some((argument) => /(?:^|\s)(?:w|e)\s+[^\s]/i.test(argument))) return false;

	switch (command) {
		case "git":
			return isSafeGitCommand(args);
		case "npm":
		case "yarn":
		case "pnpm":
			return isSafePackageQuery(args);
		case "python":
		case "python3":
		case "node":
		case "deno":
		case "bun":
			return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
		case "command":
			return args[0] === "-v" || args[0] === "--verbose";
		case "sort":
			return !args.some((argument) => argument === "-o" || argument === "--output" || argument.startsWith("--output="));
		case "sed":
			return (args.includes("-n") || args.includes("--quiet")) && !args.some((argument) => /(?:^|[;{}\/\d])w(?:\s|$)|(?:^|[;{}\/])e(?:\s|$)/i.test(argument));
		case "curl":
			return !args.some((argument) => /^(?:-o|--output(?:=|$)|-O|--remote-name|--remote-name-all|-T|--upload-file|-d|--data(?:-|=|$)|-F|--form(?:=|$)|-X|--request(?:=|$)|-K|--config(?:=|$)|--url-query|--trace(?:=|$)|--stderr(?:=|$)|--dump-header(?:=|$)|--cookie-jar(?:=|$))/.test(argument));
		case "wget":
			return hasStdoutWgetOutput(args);
		case "find":
			return !args.some((argument) => /^(?:-exec|--exec|--execdir|-ok|--ok|--delete|-fprint|-fprintf|-fls)$/i.test(argument));
		case "fd":
			return !args.some((argument) => /^(?:-x|--exec|-X|--exec-batch)$/i.test(argument));
		case "gpg":
			return ["--verify", "--list-keys", "--list-sigs", "--list-secret-keys", "--fingerprint"].includes(args[0] ?? "");
		case "openssl":
			return !args.some((argument) => /^(?:-out|--out|--keyout|-passout)$/i.test(argument));
		case "direnv":
			return args[0] === "dump" || args[0] === "status";
		case "awk":
			return !text.includes(">");
		default:
			return true;
	}
}

function isSafeGitCommand(args: string[]): boolean {
	const subcommand = args[0];
	if (!subcommand) return false;
	if (["add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "switch", "restore", "stash", "cherry-pick", "revert", "init", "clone", "clean", "gc", "prune"].includes(subcommand)) return false;
	if (["diff", "log", "show", "grep"].includes(subcommand)) {
		return !args.some((argument) => ["--ext-diff", "--textconv", "--no-index", "--output", "--filters"].includes(argument) || argument.startsWith("--output="));
	}
	if (subcommand === "config") {
		return ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].some((flag) => args.includes(flag));
	}
	if (subcommand === "remote") {
		const action = args[1];
		return action === undefined || action === "-v" || action === "--verbose" || action === "get-url" || (action === "show" && args.includes("-n"));
	}
	if (subcommand === "branch") {
		return !args.some((argument) => /^(?:-+[dDmcMCfF]|--(?:delete|move|copy|force|edit-description|set-upstream-to))/.test(argument));
	}
	if (subcommand === "tag") return args.length === 1 || args.includes("-l") || args.includes("--list");
	return ["status", "ls-files", "ls-tree", "rev-parse", "describe", "ls-remote", "merge-base", "blame", "cat-file"].includes(subcommand);
}

function isSafePackageQuery(args: string[]): boolean {
	return ["list", "ls", "view", "info", "why", "search", "outdated", "audit"].includes(args[0] ?? "");
}

function hasStdoutWgetOutput(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === undefined) continue;
		if (argument === "-qO-" || argument === "-O-" || argument === "--output-document=-") return true;
		if (/^(?:--save-cookies|--post-file|--body-data|--method)(?:=|$)/i.test(argument)) return false;
		if ((argument === "-O" || argument === "--output-document") && args[index + 1] === "-") return true;
	}
	return false;
}

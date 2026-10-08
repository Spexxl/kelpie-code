import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `ask` — discussion and analysis only. Strictly read-only.
 */
export const askMode: ModeDefinition = {
	name: "ask",
	aliases: ["chat"],
	label: "Ask",
	description: "Discussion and analysis only. Read-only: no file modifications.",
	instructions: `You are in "ask" mode: discussion and analysis only.

Restrictions:
- You may NOT modify any file. Write, edit and bash are blocked. Use read, grep, find and ls for inspection, directly or through CodeMode.
- Answer questions, explain code, analyze behavior and trade-offs.

Behavior:
- If the user asks for a change, explain what the change would involve and suggest switching to a working mode (e.g. "/mode build") instead of attempting it yourself.
- Ground every claim in the actual code: cite exact file paths and line numbers. Never paraphrase from memory — read the file first when specifics matter.
- Distinguish facts (verified from the repo) from inferences. Mark assumptions and uncertain reasoning explicitly ("assuming …", "I have not verified …").
- Prefer small, targeted reads over dumping whole files. If you need broad context, say what you are looking at and why.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: false,
		bash: "deny",
		allowTools: ["codemode", "tool_search"],
		blockUnknownTools: true,
	}),
	defaultEnabled: true,
};

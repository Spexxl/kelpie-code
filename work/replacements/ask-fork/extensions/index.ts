/**
 * pi-agent-modes — switchable workflow modes for the Pi coding agent.
 *
 * Modes: ask, plan, build (alias: act), review, debug, yolo.
 *
 * Enforcement layers (Pi has no native permission system, so everything is
 * implemented here):
 * 1. `tool_call` hook blocks write tools / restricted bash / blocked tools.
 * 2. `pi.setActiveTools()` removes write tools from the model's tool list
 *    while a read-only mode is active (defense in depth), restored on exit.
 * 3. `before_agent_start` injects the mode's instructions into the system
 *    prompt every turn.
 *
 * Persistence: `pi.appendEntry("pi-modes", state)` on every switch, restored
 * on `session_start` from the current branch (fork-aware).
 *
 * Configuration: `~/.pi/agent/modes.config.json` (global) and
 * `.pi/modes.config.json` (project, only when the project is trusted).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EffectiveMode, ModesConfig, ThinkingLevel } from "../src/types.ts";
import { ModeRegistry, cycleMode } from "../src/modes/registry.ts";
import {
	CONFIG_FILE_NAME,
	parseModesConfig,
	resolveEffectiveModes,
	pickInitialMode,
	type ConfigValidationIssue,
} from "../src/config.ts";
import { evaluateToolCall, filterActiveTools } from "../src/guard.ts";
import { buildModePromptSection } from "../src/instructions.ts";
import { MODE_STATE_ENTRY_TYPE, buildStateEntry, extractState, nextPrevious } from "../src/state.ts";
import { modeNotificationText, modeStatusText } from "../src/ui.ts";
import {
	type PlanStep,
	extractPlanSteps,
	markCompletedSteps,
	completedCount,
	renderStepLines,
} from "../src/modes/plan-tracker.ts";

/** Keyboard shortcut for "return to previous mode". */
const MODE_BACK_SHORTCUT = Key.ctrlAlt("m");

/** Keyboard shortcut for "cycle to the next mode" (quick switching). */
const MODE_CYCLE_SHORTCUT = Key.alt("m");

/** Widget shown directly above the input bar (TUI only). */
const MODE_WIDGET_KEY = "pi-modes";

/** Widget showing the plan-mode step checklist. */
const PLAN_WIDGET_KEY = "pi-modes-plan";

/** Custom message type used to kick off plan execution after a switch. */
const PLAN_EXECUTE_TYPE = "pi-modes-plan-execute";
const PLAN_COMPLETE_TOOL = "pi_modes_plan_complete";

/** Does the mode need the active tool set to be filtered? `blockTools` entries are handled by the tool_call hook, not by list filtering. */
function isRestricting(mode: EffectiveMode): boolean {
	return !mode.policy.allowWriteTools || mode.policy.bash === "deny" || mode.policy.blockUnknownTools;
}

/**
 * Extract concatenated text from an assistant message's content blocks, without
 * importing pi-ai/pi-agent-core types (kept dependency-free). Returns `null` for
 * non-assistant messages or messages with no text content.
 */
function assistantText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const msg = message as { role?: unknown; content?: unknown };
	if (msg.role !== "assistant") return null;
	const content = msg.content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

// Cooperates with the existing versioned workflow protocol used by pi-plan-mode.
const WORKFLOW_MUTEX_CHANNEL = "workflow:mutex:v1";
const AGENT_WORKFLOW_GROUP = "agent-workflow";

export default function (pi: ExtensionAPI): void {
	const registry = new ModeRegistry();

	// ------------------------------------------------------------------ state
	let effective = new Map<string, EffectiveMode>();
	let issues: ConfigValidationIssue[] = [];
	let current: EffectiveMode | undefined;
	let previousMode: string | undefined;
	let configuredDefaultMode: string | undefined;
	/** Whether the startup-only --modes flag selected the initial mode. */
	let cliModeOverride = false;
	/** Active tools captured when a restricting mode was entered. */
	let savedTools: string[] | undefined;
	/** The thinking level active before a mode forced its own (to restore on exit). */
	let savedThinkingLevel: ThinkingLevel | undefined;
	/** Whether a mode is currently forcing a thinking level. */
	let thinkingOverridden = false;
	/** Plan steps tracked while in plan mode / execution. */
	let planSteps: PlanStep[] = [];
	/** True once a plan has been detected and execution is under way. */
	let planExecuting = false;
	/** The accepted Markdown plan, when one has been detected. */
	let planMarkdown = "";
	/** Candidate plan waiting for the agent run to settle before prompting. */
	let pendingPlan: PlanStep[] = [];

	function currentModeName(): string | undefined {
		return current?.name;
	}

	pi.registerTool({
		name: PLAN_COMPLETE_TOOL,
		label: "Complete Plan",
		description: "Submit a complete implementation plan after exploration. Use this as the final standalone action in plan mode.",
		parameters: Type.Object({
			plan: Type.String({ minLength: 1, maxLength: 50000, description: "The complete Markdown implementation plan" }),
			steps: Type.Array(
				Type.Object({
					step: Type.Integer({ minimum: 1 }),
					text: Type.String({ minLength: 4, maxLength: 1000 }),
				}),
				{ minItems: 1, maxItems: 100 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (currentModeName() !== "plan") {
				throw new Error("pi_modes_plan_complete is available only while plan mode is active.");
			}
			const steps = params.steps.map((step, index) => ({
				step: index + 1,
				text: step.text.trim(),
				completed: false,
			}));
			if (steps.some((step) => step.text.length < 4)) {
				throw new Error("Every plan step must contain at least four non-whitespace characters.");
			}
			planSteps = steps;
			planMarkdown = params.plan.trim();
			pendingPlan = steps.map((step) => ({ ...step }));
			updatePlanWidget(ctx);
			persist();
			return {
				content: [{ type: "text", text: `Plan accepted with ${steps.length} step(s).` }],
				details: { plan: planMarkdown, steps },
				terminate: true,
			};
		},
	});

	/** Plan persists this public branch state before taking workflow ownership. */
	function branchHasActivePlan(ctx: ExtensionContext): boolean {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== "plan-mode-state") continue;
			const data = entry.data;
			return data !== null && typeof data === "object" && !Array.isArray(data) &&
				(data as { enabled?: unknown }).enabled === true;
		}
		return false;
	}

	/** Check before changing mode state or the active tool snapshot. */
	function admitMode(target: EffectiveMode | undefined, ctx: ExtensionContext): boolean {
		if (target?.name !== "ask") return true;
		const attempt = { session: ctx.sessionManager, group: AGENT_WORKFLOW_GROUP, busy: false };
		try {
			if (!branchHasActivePlan(ctx)) {
				pi.events.emit(WORKFLOW_MUTEX_CHANNEL, attempt);
				if (attempt.busy === false && attempt.session === ctx.sessionManager && attempt.group === AGENT_WORKFLOW_GROUP) return true;
			}
		} catch {
			// Deny when our own query fails. Pi logs and swallows foreign listener errors.
		}
		ctx.ui.notify('Ask cannot start while another workflow is active. Exit Plan with /plan off, then use /mode ask.', "warning");
		return false;
	}

	function admittedRestore(target: EffectiveMode | undefined, ctx: ExtensionContext): EffectiveMode | undefined {
		if (admitMode(target, ctx)) return target;
		// Build makes no new tool restriction. Never snapshot a foreign workflow's tools.
		return effective.get("build");
	}

	// ------------------------------------------------------------------ tools
	function applyActiveTools(): void {
		if (!current) return;
		if (!isRestricting(current)) {
			if (savedTools) {
				// Restore the original snapshot while preserving tools added by
				// other extensions during the restricted-mode interval.
				pi.setActiveTools([...new Set([...savedTools, ...pi.getActiveTools()])]);
				savedTools = undefined;
			}
			return;
		}
		if (savedTools === undefined) savedTools = pi.getActiveTools();
		const customTools = new Set(
			pi.getAllTools()
				.filter((tool) => tool.sourceInfo.source !== "builtin")
				.map((tool) => tool.name),
		);
		const candidateTools = [...new Set([...(savedTools ?? []), ...pi.getActiveTools()])];
		pi.setActiveTools(filterActiveTools(candidateTools, current.policy, customTools));
	}

	/**
	 * Force the mode's thinking level (if any) via `pi.setThinkingLevel()`.
	 * Saves the user's previous level so it can be restored when leaving.
	 */
	function applyThinkingLevel(): void {
		const level = current?.policy.thinkingLevel;
		if (!level) {
			// Mode does not force a level: restore the saved one, if any.
			if (thinkingOverridden && savedThinkingLevel !== undefined) {
				pi.setThinkingLevel(savedThinkingLevel);
			}
			thinkingOverridden = false;
			savedThinkingLevel = undefined;
			return;
		}
		if (!thinkingOverridden) {
			savedThinkingLevel = pi.getThinkingLevel();
			thinkingOverridden = true;
		}
		pi.setThinkingLevel(level);
	}

	// -------------------------------------------------------------------- UI
	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-modes", current ? modeStatusText(current, ctx.ui.theme) : undefined);
	}

	/** Show the current mode name directly above the input bar. */
	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(MODE_WIDGET_KEY, current ? [current.name] : undefined);
	}

	/**
	 * Render the plan step checklist above the input bar while a plan is being
	 * tracked, and reflect completion in the footer status. Cleared otherwise.
	 */
	/** Tracked plan is visible while in plan mode or during plan execution. */
	function planWidgetVisible(): boolean {
		return planSteps.length > 0 && (current?.name === "plan" || planExecuting);
	}

	/**
	 * Render the plan step checklist above the input bar while a plan is being
	 * tracked, and reflect completion in the footer status. Cleared otherwise.
	 */
	function updatePlanWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			// Footer status is the source of truth in non-TUI modes.
			if (planWidgetVisible()) {
				ctx.ui.setStatus(PLAN_WIDGET_KEY, ctx.ui.theme.fg("accent", `📋 ${completedCount(planSteps)}/${planSteps.length}`));
			} else {
				ctx.ui.setStatus(PLAN_WIDGET_KEY, undefined);
			}
			return;
		}
		if (planWidgetVisible()) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, renderStepLines(planSteps, (c, t) => ctx.ui.theme.fg(c as ThemeColor, t)));
			ctx.ui.setStatus(PLAN_WIDGET_KEY, ctx.ui.theme.fg("accent", `📋 ${completedCount(planSteps)}/${planSteps.length}`));
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
			ctx.ui.setStatus(PLAN_WIDGET_KEY, undefined);
		}
	}

	// ------------------------------------------------------------ persistence
	function persist(): void {
		if (!current) return;
		pi.appendEntry(
			MODE_STATE_ENTRY_TYPE,
			buildStateEntry(current.name, previousMode, planSteps, planExecuting, planMarkdown),
		);
	}

	function restorePlanState(
		steps: readonly PlanStep[] | undefined,
		executing: boolean | undefined,
		markdown = "",
	): void {
		planSteps = steps?.map((step) => ({ ...step })) ?? [];
		planExecuting = executing === true && planSteps.length > 0;
		planMarkdown = markdown.trim();
		pendingPlan = [];
	}

	function restoreBranchState(ctx: ExtensionContext): void {
		const persisted = extractState(ctx.sessionManager.getBranch());
		const initial = pickInitialMode(
			effective,
			undefined,
			persisted?.mode,
			configuredDefaultMode,
			issues,
			(name) => registry.canonicalName(name),
		);
		current = admittedRestore(initial, ctx);
		previousMode = persisted?.previousMode ? registry.canonicalName(persisted.previousMode) : undefined;
		restorePlanState(persisted?.planSteps, persisted?.planExecuting, persisted?.planMarkdown);
		applyActiveTools();
		applyThinkingLevel();
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
	}

	// -------------------------------------------------------------- switching
	function switchTo(name: string, ctx: ExtensionContext): boolean {
		const resolved = registry.resolve(name);
		if (!resolved) {
			ctx.ui.notify(`Unknown mode "${name}". Available: ${[...effective.keys()].join(", ")}`, "error");
			return false;
		}
		const target = effective.get(resolved.name);
		if (!target) {
			ctx.ui.notify(`Mode "${resolved.name}" is disabled in modes.config.json.`, "error");
			return false;
		}
		if (current?.name === target.name) {
			ctx.ui.notify(`Already in mode "${target.name}".`, "info");
			return true;
		}
		if (!admitMode(target, ctx)) return false;
		previousMode = nextPrevious(current?.name, target.name);
		current = target;
		applyActiveTools();
		applyThinkingLevel();
		// Entering a non-plan mode clears tracked plan steps, unless we are
		// mid-execution (the Execute flow keeps tracking [DONE:n] in build).
		if (target.name !== "plan" && !planExecuting) {
			restorePlanState(undefined, false);
		}
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
		return true;
	}

	/** Cycle to the next (1) or previous (-1) enabled mode. */
	function cycleTo(ctx: ExtensionContext, direction: 1 | -1): void {
		if (!current) return;
		const next = cycleMode([...effective.keys()], current.name, direction);
		if (!next) {
			ctx.ui.notify("Nothing to cycle: fewer than two enabled modes.", "info");
			return;
		}
		switchTo(next, ctx);
	}

	function switchToPrevious(ctx: ExtensionContext): void {
		if (!previousMode || !current) {
			ctx.ui.notify("No previous mode to return to.", "info");
			return;
		}
		const target = effective.get(previousMode);
		if (!target) {
			ctx.ui.notify(`Previous mode "${previousMode}" is disabled or unknown; nothing to return to.`, "warning");
			previousMode = undefined;
			return;
		}
		// The previous mode becomes current; the old current becomes previous
		// (toggle semantics: ask -> plan -> back -> ask -> back -> plan ...).
		if (!admitMode(target, ctx)) return;
		const oldCurrent = current;
		current = target;
		previousMode = oldCurrent.name;
		applyActiveTools();
		applyThinkingLevel();
		if (target.name !== "plan" && !planExecuting) {
			restorePlanState(undefined, false);
		}
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
	}

	async function executePlan(ctx: ExtensionContext): Promise<boolean> {
		if (current?.name !== "plan" || planSteps.length === 0) {
			ctx.ui.notify("No executable plan is currently available in plan mode.", "warning");
			return false;
		}
		const candidate = planSteps.map((step) => ({ ...step }));
		const remaining = candidate.filter((step) => !step.completed).map((step) => `${step.step}. ${step.text}`).join("\n");
		const first = candidate.find((step) => !step.completed)?.text ?? candidate[0]?.text ?? "the first step";
		planExecuting = true;
		const switched = switchTo("build", ctx);
		if (!switched) {
			restorePlanState(candidate, false, planMarkdown);
			updatePlanWidget(ctx);
			ctx.ui.notify("[modes] Cannot execute the plan because build mode is disabled.", "error");
			return false;
		}
		persist();
		pi.sendMessage(
			{
				customType: PLAN_EXECUTE_TYPE,
				content: `Execute the plan.\n\nRemaining steps:\n${remaining || "(all steps were already marked complete)"}\n\nStart with: ${first}.\nAfter completing a step, include a [DONE:n] tag in your response.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
	}

	async function exportPlan(pathArg: string, ctx: ExtensionContext): Promise<void> {
		if (!planMarkdown.trim()) {
			ctx.ui.notify("No accepted plan is available to export.", "warning");
			return;
		}
		const relativeOrAbsolute = (pathArg.trim() || "PLAN.md").replace(/^@/, "");
		const target = resolve(ctx.cwd, relativeOrAbsolute);
		try {
			await writeFile(target, `${planMarkdown.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
			ctx.ui.notify(`Plan exported to ${target}.`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not export plan to ${target}: ${(error as Error).message}`, "error");
		}
	}

	function showPlan(ctx: ExtensionContext): void {
		if (!planSteps.length && !planMarkdown.trim()) {
			ctx.ui.notify("No accepted plan is currently available.", "info");
			return;
		}
		const steps = planSteps.map((step) => `${step.completed ? "☑" : "☐"} ${step.step}. ${step.text}`).join("\n");
		ctx.ui.notify(`Plan${planExecuting ? " (implementing)" : ""}:\n${steps || planMarkdown}`, "info");
	}

	function describeCurrent(): string {
		if (!current) return "No mode active.";
		const lines: string[] = [];
		const aliasText = current.aliases.length > 0 ? ` (aliases: ${current.aliases.join(", ")})` : "";
		const levelText = current.policy.thinkingLevel ? ` — thinking: ${current.policy.thinkingLevel}` : "";
		lines.push(
			`Current mode: ${current.name}${current.policy.allowWriteTools ? "" : " (read-only)"}${aliasText}${levelText}${
				previousMode ? ` — previous: ${previousMode}` : ""
			}`,
		);
		lines.push("");
		lines.push("Available modes:");
		for (const mode of effective.values()) {
			const marker = mode.name === current.name ? " * " : "   ";
			const access = mode.policy.allowWriteTools ? "" : " 🔒";
			const aliases = mode.aliases.length > 0 ? ` [${mode.aliases.join(", ")}]` : "";
			lines.push(`${marker}${mode.name.padEnd(8)}${access}${aliases}  ${mode.description}`);
		}
		lines.push("");
		lines.push("Switch: /mode <name|alias>   |   cycle: alt+m   |   back: /mode back or ctrl+alt+m");
		return lines.join("\n");
	}

	// --------------------------------------------------------------- config
	async function loadConfigs(ctx: ExtensionContext): Promise<{ config: ModesConfig; issues: ConfigValidationIssue[] }> {
		const loaded: Array<{ config: ModesConfig; issues: ConfigValidationIssue[] }> = [];
		const sources: Array<{ path: string; include: boolean }> = [
			{ path: join(getAgentDir(), CONFIG_FILE_NAME), include: true },
			{ path: join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), include: ctx.isProjectTrusted() },
		];
		for (const source of sources) {
			if (!source.include) continue;
			try {
				const raw = await readFile(source.path, "utf8");
				loaded.push(parseModesConfig(raw, source.path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					loaded.push({
						config: {},
						issues: [{ path: source.path, message: `Failed to read config: ${(error as Error).message}` }],
					});
				}
			}
		}
		// Merge: project overrides global (top-level keys and per-mode keys).
		const merged: ModesConfig = {};
		const allIssues: ConfigValidationIssue[] = [];
		for (const item of loaded) {
			allIssues.push(...item.issues);
			if (item.config.defaultMode !== undefined) merged.defaultMode = item.config.defaultMode;
			for (const [name, override] of Object.entries(item.config.modes ?? {})) {
				merged.modes = merged.modes ?? {};
				merged.modes[name] = { ...merged.modes[name], ...override };
			}
		}
		return { config: merged, issues: allIssues };
	}

	function reportIssues(ctx: ExtensionContext): void {
		for (const issue of issues) {
			ctx.ui.notify(`[modes] Config: ${issue.message}`, "warning");
		}
	}

	// ---------------------------------------------------------------- events
	pi.on("session_start", async (event, ctx) => {
		const loaded = await loadConfigs(ctx);
		effective = resolveEffectiveModes(registry, loaded.config, loaded.issues);
		issues = loaded.issues;
		configuredDefaultMode = loaded.config.defaultMode;

		const cliMode = typeof pi.getFlag("modes") === "string" ? (pi.getFlag("modes") as string) : undefined;
		cliModeOverride = cliMode !== undefined;
		const persisted = extractState(ctx.sessionManager.getBranch());
		const initial = pickInitialMode(
			effective,
			cliMode,
			persisted?.mode,
			loaded.config.defaultMode,
			issues,
			(name) => registry.canonicalName(name),
		);
		current = admittedRestore(initial, ctx);
		previousMode = persisted?.previousMode ? registry.canonicalName(persisted.previousMode) : undefined;
		restorePlanState(persisted?.planSteps, persisted?.planExecuting, persisted?.planMarkdown);
		applyActiveTools();
		applyThinkingLevel();
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		if (!cliModeOverride) persist();
		if (event.reason === "startup" || event.reason === "reload") {
			reportIssues(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreBranchState(ctx);
	});

	pi.on("session_shutdown", () => {
		// Session-scoped state is re-established in session_start.
		effective = new Map();
		current = undefined;
		previousMode = undefined;
		configuredDefaultMode = undefined;
		cliModeOverride = false;
		if (savedTools) pi.setActiveTools(savedTools);
		savedTools = undefined;
		savedThinkingLevel = undefined;
		thinkingOverridden = false;
		restorePlanState(undefined, false);
	});

	// Read-only enforcement: blocks write tools and unsafe bash.
	pi.on("tool_call", (event) => {
		if (!current) return;
		const decision = evaluateToolCall({
			modeName: current.name,
			policy: current.policy,
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		});
		if (decision.blocked) return { block: true, reason: decision.reason };
	});

	// Re-apply restrictions before every provider request so dynamically activated
	// extension tools cannot bypass the active mode's tool policy.
	pi.on("before_agent_start", (event) => {
		if (!current) return;
		applyActiveTools();
		return { systemPrompt: event.systemPrompt + "\n\n" + buildModePromptSection(current) };
	});

	/**
	 * Plan tracking: when an assistant message in `plan` mode contains a
	 * "Plan:" section, extract its numbered steps, show a progress widget, and
	 * offer to execute (which switches to `build` and injects the plan).
	 * `[DONE:n]` markers mark steps complete during execution.
	 */
	pi.on("message_end", (event, ctx) => {
		if (!current) return;
		const text = assistantText(event.message);
		if (!text) return;

		// Mark completed steps from [DONE:n] markers (execution phase).
		if (planSteps.length > 0) {
			const newlyDone = markCompletedSteps(text, planSteps);
			if (newlyDone > 0) {
				updatePlanWidget(ctx);
				persist();
			}
		}

		// Detect a candidate plan, but wait for agent_settled before asking what to
		// do next. message_end can fire before sibling tool calls or retries finish.
		if (current.name !== "plan" || planExecuting) return;
		const fresh = extractPlanSteps(text);
		if (fresh.length === 0) return;
		planSteps = fresh;
		planMarkdown = text;
		pendingPlan = fresh.map((step) => ({ ...step }));
		updatePlanWidget(ctx);
		persist();
		ctx.ui.notify(`[modes] Plan detected: ${fresh.length} step(s).`, "info");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!current) return;

		if (planExecuting && planSteps.length > 0 && completedCount(planSteps) === planSteps.length) {
			ctx.ui.notify("[modes] Plan complete.", "info");
			restorePlanState(undefined, false);
			updatePlanWidget(ctx);
			persist();
			return;
		}

		// Automatic selection is deliberately TUI-only. RPC clients can use
		// /mode build explicitly and never get stuck waiting for a dialog.
		if (current.name !== "plan" || planExecuting || pendingPlan.length === 0 || ctx.mode !== "tui") return;
		const candidate = pendingPlan.map((step) => ({ ...step }));
		pendingPlan = [];
		const choice = await ctx.ui.select("Plan mode — what next?", [
			"Execute the plan (switch to build)",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (!choice) return;
		if (choice.startsWith("Execute")) {
			await executePlan(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pendingPlan = candidate;
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// -------------------------------------------------------------- commands
	pi.registerCommand("mode", {
		description: "Show or switch the active mode (ask, plan, build, review, debug, yolo)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "back", label: "back", description: "Return to the previous mode" },
				...[...effective.values()].flatMap((mode) => {
					const itemsForMode: AutocompleteItem[] = [
						{ value: mode.name, label: mode.name, description: mode.description },
					];
					for (const alias of mode.aliases) {
						itemsForMode.push({
							value: alias,
							label: alias,
							description: `alias of ${mode.name}: ${mode.description}`,
						});
					}
					return itemsForMode;
				}),
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const rawArg = (args ?? "").trim();
			const arg = rawArg.toLowerCase();
			if (!arg) {
				ctx.ui.notify(describeCurrent(), "info");
				return;
			}
			if (arg === "back") {
				switchToPrevious(ctx);
				return;
			}
			const [first, subcommand, ...rest] = rawArg.split(/\s+/);
			if (registry.resolve(first ?? "")?.name === "plan" && subcommand) {
				switch (subcommand.toLowerCase()) {
					case "show":
						showPlan(ctx);
						return;
					case "save":
						if (planSteps.length === 0 && !planMarkdown.trim()) {
							ctx.ui.notify("No plan is currently available to save.", "warning");
							return;
						}
						persist();
						ctx.ui.notify("Plan progress saved in the current session.", "info");
						return;
					case "export":
						await exportPlan(rest.join(" "), ctx);
						return;
					case "implement":
						await executePlan(ctx);
						return;
				}
			}
			switchTo(arg, ctx);
		},
	});

	pi.registerShortcut(MODE_BACK_SHORTCUT, {
		description: "Return to the previous mode",
		handler: async (ctx: ExtensionContext) => switchToPrevious(ctx),
	});

	pi.registerShortcut(MODE_CYCLE_SHORTCUT, {
		description: "Cycle to the next mode (ask -> plan -> build -> review -> debug -> yolo)",
		handler: async (ctx: ExtensionContext) => cycleTo(ctx, 1),
	});

	pi.registerFlag("modes", {
		description: "Start in the given mode (ask, plan, build, review, debug, yolo)",
		type: "string",
	});
}

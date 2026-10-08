import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { planModeToolAvailability } from "./tool-availability.js";
import {
  canSelectToolInPlanMode,
  classifyPlanModeTool,
  isBuiltinTool,
  SAFE_BUILTIN_PLAN_TOOLS,
} from "./tool-policy.js";

export function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
  const directName = tools.find((tool) => tool.name === key)?.name;
  if (directName) return directName;
  const [name] = key.split("\u001f");
  return tools.find((tool) => tool.name === name) ? name : undefined;
}

export function compareTools(left: ToolInfo, right: ToolInfo) {
  const leftBuiltin = isBuiltinTool(left);
  const rightBuiltin = isBuiltinTool(right);
  if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function toolPolicyLabel(tool: ToolInfo) {
  const policy = classifyPlanModeTool(tool);
  if (policy === "read-only") return "built-in read-only";
  if (policy === "limited") return "built-in limited";
  if (policy === "blocked") return tool.sourceInfo?.source ? "built-in blocked" : "policy metadata unavailable";
  return `user opt-in: ${toolSourceLabel(tool)}`;
}

export function planModeToolSelection(tool: ToolInfo, activeNames: ReadonlySet<string>, retained: boolean) {
  const availability = planModeToolAvailability(tool, activeNames);
  const policyBlocked = !canSelectToolInPlanMode(tool);
  let unavailable: string | undefined;
  switch (availability) {
    case "inactive":
      unavailable = "Not active in Pi; Plan mode will not activate it";
      if (!policyBlocked && isBuiltinTool(tool) && ["grep", "find", "ls"].includes(tool.name)) {
        // ExtensionContext does not expose host-owned Pi settings; plain names also work before Pi 0.99.
        unavailable += `; on Pi with defaultTools support, use a full list including "${tool.name}" in this session's Pi settings (preserve existing/default tools), then restart Pi`;
      }
      if (retained) unavailable += "; retained and resolved before the first request";
      break;
    case "hidden":
      unavailable = "Hidden in Pi; retained selection cannot enable it";
      break;
    case "unsupported":
      unavailable = "Unsupported tool exposure; Plan mode cannot enable it";
      break;
  }
  const policy =
    (policyBlocked ? undefined : unavailable) ??
    [
      toolPolicyLabel(tool),
      ...(tool.exposure === "codemode" || tool.exposure === "deferred" ? ["callable via other tools"] : []),
      ...(tool.exposure === "model-only" ? ["model calls only"] : []),
    ].join(" · ");
  const description = tool.description ?? "No description available";
  const disabledReason = policyBlocked ? "Blocked by Plan-mode policy" : unavailable;
  const label = policyBlocked
    ? `${tool.name} — blocked by Plan policy`
    : availability === "inactive"
      ? `${tool.name} — inactive in Pi`
      : tool.name;
  return {
    label,
    description: `${policy} · ${description}`,
    searchText: `${policy} ${description}`,
    disabled: disabledReason !== undefined,
    disabledReason,
  };
}

function toolSourceLabel(tool: ToolInfo) {
  const sourceInfo = tool.sourceInfo;
  const source = `${sourceInfo.scope}/${sourceInfo.source}`;
  return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

export function unique(values: string[]) {
  return Array.from(new Set(values));
}

export function filterAvailableSelectedToolNames(
  names: string[],
  tools: ToolInfo[],
  activeNames: ReadonlySet<string> = new Set(tools.map((tool) => tool.name)),
) {
  const availableNames = new Set(
    tools
      .filter((tool) => canSelectToolInPlanMode(tool) && planModeToolAvailability(tool, activeNames) === "available")
      .map((tool) => tool.name),
  );
  return unique(names.filter((name) => availableNames.has(name)));
}

export function defaultPlanModeToolNames(tools: ToolInfo[], configuredNames: string[] | undefined) {
  if (configuredNames !== undefined) return unique(configuredNames);
  return tools.filter((tool) => isBuiltinTool(tool) && SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)).map((tool) => tool.name);
}

interface PlanModeToolSelectionSnapshot {
  selectedToolNames?: string[];
  selectedToolKeys?: string[];
  defaultPlanTools?: string[];
}

export function snapshotPlanModeSelectedNames(tools: ToolInfo[], selection: PlanModeToolSelectionSnapshot) {
  const selectedToolNames =
    selection.selectedToolNames ??
    selection.selectedToolKeys
      ?.map((key) => toolNameFromLegacyKey(key, tools))
      .filter((name): name is string => name !== undefined);
  return new Set(
    selectedToolNames === undefined
      ? defaultPlanModeToolNames(tools, selection.defaultPlanTools)
      : unique(selectedToolNames),
  );
}

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type PlanModeToolAvailability = "available" | "inactive" | "hidden" | "model-only" | "unsupported";

/** Pi's active set is model declaration, not the complete callable registry. */
export function planModeToolAvailability(
  tool: ToolInfo,
  activeNames: ReadonlySet<string>,
  route: "selection" | "model" | "nested" = "selection",
): PlanModeToolAvailability {
  switch (tool.exposure) {
    case "hidden":
      return "hidden";
    case "model-only":
      if (route === "nested") return "model-only";
      return activeNames.has(tool.name) ? "available" : "inactive";
    case "codemode":
    case "deferred":
      if (route !== "model") return "available";
      return activeNames.has(tool.name) ? "available" : "inactive";
    case undefined: // Older Pi versions exposed only directly active tools.
    case "direct":
      return activeNames.has(tool.name) ? "available" : "inactive";
    default:
      return "unsupported";
  }
}

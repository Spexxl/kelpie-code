import { type Page } from "playwright";
import { generateText } from "ai";
import { SeedCookie, TypingWarningCode } from "./lib.js";
import { type JevTransport } from "./provider.js";
export interface NavigateOptions {
    task: string;
    /** Start URL for an internally-created page. Omit when `page` is supplied. */
    startUrl?: string;
    /** Reuse an existing Playwright page instead of launching a new browser. */
    page?: Page;
    /** Override judgment transport for this run, independent of JEV_PROVIDER and credentials. */
    transport?: JevTransport;
    maxSteps?: number;
    maxSeconds?: number;
    allowTyping?: boolean;
    format?: "text" | "markdown" | "html" | "aria";
    maxChars?: number;
    screenshot?: "final" | "none";
    recordDir?: string;
    password?: {
        value: string;
        origin: string;
    };
    /**
     * Seed cookies added to the run's own browser context before the first
     * navigation, so a run can start behind a login the agent cannot perform
     * itself (password fields are never typed into). Values are secrets of the
     * same rank as the password and are redacted from every state, trace,
     * error, payload, and result this function produces; recording is refused
     * and the final screenshot is suppressed from run start (the page can
     * reflect a cookie value into pixels on the very first load). Refused on
     * runs with an injected page: addCookies would mutate a caller-owned
     * context. Never source values from anything model-composed (the CLI and
     * MCP adapters take file or environment references, never values).
     */
    cookies?: SeedCookie[];
}
export interface StepRecord {
    step: number;
    t_ms?: number;
    proposed_action: string;
    executed_action: string | null;
    detail: string;
    recovery_reason?: string;
    action_error?: string;
    outcome: string;
    confidence: number | null;
    top_probability: number | null;
    goal_done: number;
    stuck: number;
}
export interface ConsoleEvent {
    step: number;
    type: "console_error" | "console_warning" | "page_error" | "request_failed";
    text: string;
    page: string;
}
export interface JevUsage {
    jev_calls: number;
    input_tokens: number;
    output_tokens: number;
    est_cost_usd: number;
}
export interface TypingGenerator {
    provider: string;
    modelId: string;
    model: Parameters<typeof generateText>[0]["model"];
}
/**
 * Build the typing generator for a run. Selection logic (including the
 * strict JEV_BROWSER_TYPE_PROVIDER contract) lives in resolveTypingSelection;
 * this only wires the selected configuration to a provider client. Returns
 * null when no typing provider is configured.
 */
export declare function createTypingGenerator(env?: NodeJS.ProcessEnv): TypingGenerator | null;
export type TypingTextResult = {
    ok: true;
    text: string;
    via: string;
} | {
    ok: false;
    code: TypingWarningCode;
    message: string;
    finishReason?: string;
};
/**
 * Generate the text for one type/search action. Never falls back to the
 * keyword heuristic itself: the caller decides what a failure means (ordinary
 * fields type nothing; search fields take the heuristic) and records the
 * structured warning.
 */
export declare function generateTextToType(signal: AbortSignal, generator: TypingGenerator, task: string, elementDescription: string, url: string): Promise<TypingTextResult>;
export interface CaptureCaps {
    label: number;
    option: number;
    href: number;
}
export declare function navigate(options: NavigateOptions, externalSignal?: AbortSignal): Promise<any>;

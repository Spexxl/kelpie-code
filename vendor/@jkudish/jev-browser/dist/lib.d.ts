/** Max elements offered to Jev per step. TypeSafe Choice supports up to 255 options. */
export declare const MAX_ELEMENTS = 240;
/** Raw interactive candidate as extracted from the page (already stamped with an attr). */
export interface RawElement {
    attr: string;
    tag: string;
    role: string;
    text: string;
    href: string;
    typeAttr: string;
    clickable: boolean;
    typeable: boolean;
    selectable?: boolean;
    passwordInput?: boolean;
    searchField?: boolean;
    submitControl?: boolean;
    enterSubmittable?: boolean;
    options?: SelectOption[];
}
/** One native <select> option: its DOM index and (scrubbed) label. */
export interface SelectOption {
    i: number;
    label: string;
}
/** Pruned action-space element. */
export interface PageElement {
    id: string;
    attr: string;
    kind: "click" | "type" | "select" | "submit" | "search" | "fill_password";
    description: string;
    submitVia?: "click" | "enter";
    options?: SelectOption[];
}
export declare function isNoiseName(name: string): boolean;
export declare function isNoiseHref(href: string): boolean;
export interface BuildActionSpaceOptions {
    /** Offer fill_password actions on native password inputs. Off unless a password source is active. */
    passwordActive?: boolean;
}
/** Filter, dedupe by destination, cap, and describe the action space for one step. */
export declare function buildActionSpace(raw: RawElement[], opts?: BuildActionSpaceOptions): {
    elements: PageElement[];
    truncated: boolean;
};
/** Jev Choice criteria for one step: element actions plus loop controls. */
export declare function buildCriteria(elements: PageElement[]): Record<string, string>;
export declare function selectorFor(el: PageElement): string;
/** Next-best action from a Choice distribution, excluding known-bad options. */
export declare function pickAlternate(probabilities: Record<string, number> | undefined, exclude: Set<string>): string | null;
/** Deterministic typing fallback when no small-LLM key is available. */
export declare function heuristicQuery(task: string): string;
/** jev-1.12 published pricing: input $0.042 per M tokens, output free. */
export declare const PRICE_PER_MTOK_IN = 0.042;
/** Warning codes reported in the navigate() result when typing degraded. */
export type TypingWarningCode = "typing_fallback_no_provider" | "typing_generator_empty" | "typing_generator_error" | "typing_configuration_error";
/** One structured typing-degradation record in the result's warnings array. */
export interface TypingWarning {
    code: TypingWarningCode;
    step: number;
    message: string;
    provider: string | null;
    model: string | null;
    finish_reason?: string;
    fallback?: string;
}
/** Provider error text is capped hard: warnings travel inside result JSON. */
export declare const TYPING_WARNING_MESSAGE_MAX = 200;
/** Build one TypingWarning; optional fields stay absent, not null, when unset. */
export declare function typingWarning(code: TypingWarningCode, step: number, fields: {
    message: string;
    provider: string | null;
    model: string | null;
    finishReason?: string;
    fallback?: string;
}): TypingWarning;
/** One named typing provider, as auto-detectable by key shape. */
export interface TypingCandidateSpec {
    provider: "openai" | "openrouter" | "anthropic" | "google";
    keyEnv: string[];
    keyLabel: string;
    keyPattern: RegExp;
    defaultModel: string;
}
/** Named typing providers in auto-detection order. */
export declare const TYPING_CANDIDATES: TypingCandidateSpec[];
/** Resolved typing configuration, before any provider client is built. */
export interface TypingSelection {
    provider: "openai" | "openrouter" | "anthropic" | "google" | "compatible-endpoint";
    modelId: string;
    /** JEV_BROWSER_TYPE_BASE_URL: a custom OpenAI-compatible endpoint on its own, or the endpoint of the explicitly selected provider. */
    baseUrl?: string;
}
/**
 * Resolve the typing generator configuration from an env record. Pure.
 *
 * - JEV_BROWSER_TYPE_PROVIDER, when set, selects ONLY that provider: an
 *   unknown value, or a missing or malformed key for it, throws, because the
 *   run must fail up front instead of silently using another provider.
 * - JEV_BROWSER_TYPE_BASE_URL selects a custom OpenAI-compatible endpoint on
 *   its own, or becomes the endpoint of the explicitly selected provider.
 * - With neither set, auto-detection picks the first candidate whose key is
 *   present and shape-valid, in TYPING_CANDIDATES order.
 * - Returns null when nothing is configured.
 */
export declare function resolveTypingSelection(env: NodeJS.ProcessEnv): TypingSelection | null;
/**
 * Short, body-free summary of a typing-generator error. Provider response
 * bodies and JSON-ish blobs are stripped wholesale: warnings are serialized
 * into result JSON and must never carry raw provider payloads.
 */
export declare function summarizeTypingError(error: unknown): string;
/**
 * Classify a caught typing-generator failure. Anything that reached a
 * provider (an AI SDK API call error, or a network-layer failure in the
 * cause chain) is a provider failure: typing_generator_error. A failure that
 * means the request could never be built from local configuration (bad URL,
 * invalid options, schema rejection) is typing_configuration_error.
 */
export declare function classifyTypingFailure(error: unknown): TypingWarningCode;
/** Inputs the navigation loop already collects: page observables plus the
 * last-seen value of Cloudflare's cf-mitigated response header on a
 * main-document response, when one was observed. */
export interface BotProtectionSignals {
    title: string;
    /** Visible body text, whitespace-normalized; a short slice is enough. */
    excerpt: string;
    cfMitigated?: string | null;
}
export interface BotProtection {
    provider: "cloudflare";
    kind: "challenge" | "block";
    /** Short marker descriptions, at most 4; never wholesale page content. */
    evidence: string[];
    guidance: string;
    /**
     * True when the page itself shows decisive evidence (a challenge title, or
     * three body markers including a brand phrase) that stands on its own, not
     * a response header with at most incidental body phrases. Only page
     * evidence may stop a run: a cf-mitigated header alone means a challenge
     * answered the navigation, which can still auto-pass and paint the real
     * page.
     */
    from_page: boolean;
}
/**
 * Pure detector for CDN bot-protection interstitials. Stopping evidence is
 * DOM-only and self-sufficient: a Cloudflare-signature or branded challenge
 * title counts fully (generic wordings like "Verify you are human" need a
 * Cloudflare-brand body marker to corroborate them), or body markers count one
 * point each and need three, including at least one brand phrase, to stand
 * alone, so an article that quotes a few challenge lines is not flagged as a
 * wall. A marker already matched absorbs its substrings (one visual phrase is
 * one marker). `from_page` means exactly that: the page evidence alone meets
 * the stopping threshold, so the run loop's DOM-only probes agree with this
 * detector on everything that can stop a run. A cf-mitigated response header
 * is decisive for ANNOTATION only and never page evidence or a title
 * corroborator: it is last-seen state, and a challenge that auto-passed still
 * answers with the header. Block markers (a hard denial page) outrank
 * challenge markers, but only promote the kind when the evidence carrying
 * them is decisive.
 */
export declare function detectBotProtection(signals: BotProtectionSignals): BotProtection | null;
/** A cookie to seed the browser context with before the first navigation. */
export interface SeedCookie {
    name: string;
    value: string;
    /**
     * Omit (recommended): the cookie is host-only, bound to the start URL's
     * exact host and no subdomain, which is what a session cookie captured in
     * a browser usually is. Supply ".example.com" (leading dot) only when the
     * site genuinely sets a subdomain-matching domain cookie.
     */
    domain?: string;
    /** Defaults to "/" so the cookie is sent site-wide. */
    path?: string;
    /**
     * Defaults to true for https start URLs, false for http (loopback
     * fixtures stay seedable). Forced true for __Host-/__Secure- names and
     * for sameSite "None"; an explicit false cannot strip a forced flag.
     */
    secure?: boolean;
    /**
     * Defaults to true: page scripts cannot read the seeded value. Set false
     * only when the site's own JavaScript must read this cookie.
     */
    httpOnly?: boolean;
    /** Defaults to "Lax", the browser default for session cookies. */
    sameSite?: "Strict" | "Lax" | "None";
}
/**
 * Resolves seed cookies into Playwright's `addCookies` shape.
 *
 * What a caller gets when a field is omitted:
 * - domain: omitted from the output decision and sent as the start URL's
 *   hostname without a leading dot, which Chromium stores host-only (the
 *   cookie matches the exact host, never subdomains). A supplied domain is
 *   passed through verbatim; only a leading dot opts into subdomain matching.
 * - path: "/".
 * - secure: true when the start URL is https, false otherwise; forced true
 *   for __Host- and __Secure- names regardless of scheme, and for
 *   sameSite "None"; an explicit secure: false cannot strip a forced flag.
 * - httpOnly: true. Page scripts cannot read the value; the server still
 *   receives it on every request.
 * - sameSite: "Lax".
 *
 * __Host- names must be host-only with path "/" and secure: an explicit
 * domain or a non-root path on such a name is rejected, because the browser
 * would drop the cookie anyway.
 */
export declare function resolveCookies(cookies: SeedCookie[] | undefined, startUrl: string): Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: "Strict" | "Lax" | "None";
}>;
/** Parses a CLI `name=value` cookie spec. The value may itself contain `=`. */
export declare function parseCookieSpec(spec: string): SeedCookie;

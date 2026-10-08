import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const PARENT_WAKE_TEXT = "Subagent updates above.";
export interface ParentWake {
    /**
     * pi.sendMessage, except that a turn-triggering message to an idle parent is appended and the
     * turn is started with sendUserMessage. Pi starts a sendMessage-triggered run without
     * before_agent_start (earendil-works/pi#5581), so that run drops every hook-set prompt section.
     * Returns true when the message was appended that way: Pi emits no extension message_start for it.
     */
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): boolean;
    /** True from an idle wake until its run starts or the session shuts down. Past the deadline it holds only while the parent is busy, which may still be the wake's preflight (for example compacting). */
    isPending(): boolean;
    bindSession(ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">): void;
    agentStarted(): void;
    sessionShutdown(reason: string | undefined): void;
}
export declare function createParentWake(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, now?: () => number): ParentWake;
//# sourceMappingURL=parent-wake.d.ts.map
export const PARENT_WAKE_TEXT = "Subagent updates above.";
// A handled or failed wake prompt emits no agent_start. Past this deadline an idle parent's
// wake counts as abandoned: its notices are already in the session, only the turn is lost.
const WAKE_PENDING_MS = 10_000;
const reservationsSymbol = Symbol.for("pi-subagents.parent-wake-reservations.v1");
const wakeGlobal = globalThis;
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap());
export function createParentWake(pi, now = Date.now) {
    let ctx;
    let reservation = { sessionId: "" };
    const reserved = () => reservation.sentAt !== undefined && now() - reservation.sentAt < WAKE_PENDING_MS;
    return {
        sendMessage(message, options) {
            if (options?.triggerTurn !== true) {
                pi.sendMessage(message, options);
                return false;
            }
            if (!ctx.isIdle()) {
                pi.sendMessage(message, options);
                return false;
            }
            pi.sendMessage(message, { triggerTurn: false });
            if (!reserved()) {
                reservation.sentAt = now();
                // Steer queues the wake if another prompt starts the run first.
                pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
            }
            return true;
        },
        isPending: () => reservation.sentAt !== undefined && (reserved() || !ctx.isIdle()),
        bindSession(context) {
            ctx = context;
            const sessionId = context.sessionManager.getSessionId();
            const retained = reservations.get(context.sessionManager);
            reservation = retained?.sessionId === sessionId ? retained : { sessionId };
            reservations.set(context.sessionManager, reservation);
        },
        agentStarted() {
            reservation.sentAt = undefined;
        },
        sessionShutdown(reason) {
            if (reason !== "reload")
                reservation.sentAt = undefined;
        },
    };
}
//# sourceMappingURL=parent-wake.js.map
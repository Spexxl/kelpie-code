import { ask, resolveTransport } from "@jkudish/jev-agent-tools";
export { resolveTransport };
/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export class InvalidJevAnswer extends Error {
}
export async function askJev(transport, input) {
    const result = await ask(input, { transport });
    if (!result.ok) {
        if (input.signal.aborted)
            throw input.signal.reason;
        if (result.code === "request_failed")
            throw new Error(result.message);
        throw new InvalidJevAnswer(result.message);
    }
    // The package redacts unrecognized names; successful injected transports
    // still report the caller's name, as the public navigate() API promises.
    const provider = typeof transport.name === "string" && transport.name.trim() ? transport.name : "unknown";
    return { answers: result.answer, usage: result.usage, provider, model: result.model };
}
//# sourceMappingURL=provider.js.map
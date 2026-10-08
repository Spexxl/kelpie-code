import { resolveTransport } from "@jkudish/jev-agent-tools";
import type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply } from "@jkudish/jev-agent-tools";
export { resolveTransport };
export type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply };
export interface AskResult {
    answers: Record<string, JevAnswer>;
    usage: JevTransportReply["usage"];
    provider: string;
    model: string;
}
/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export declare class InvalidJevAnswer extends Error {
}
export declare function askJev(transport: JevTransport, input: JevTransportInput): Promise<AskResult>;

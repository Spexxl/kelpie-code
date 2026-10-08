/**
 * Unfinished assistant text recovered when a child ends abnormally.
 *
 * Final output is built from completed `message_end` messages, so text that was
 * still streaming when a child timed out or its session threw is otherwise lost.
 * The tracker keeps one in-memory reference to the latest unfinished assistant
 * message. Nothing is persisted.
 */
import type { ChildSessionEvent } from "./child-session.ts";
export type PartialOutputCause = "timeout" | "child error";
export interface PartialOutputTracker {
    observe(event: ChildSessionEvent): void;
    /** Latest unfinished assistant text that is newer than the last completed reply. */
    text(): string | undefined;
}
export declare function createPartialOutputTracker(): PartialOutputTracker;
export declare function formatPartialOutput(text: string, cause: PartialOutputCause): string;
//# sourceMappingURL=partial-output.d.ts.map
// The editor's question before an agent makes a public share link (9c.1). Main asks it over the session responder
// (confirmShare) unless the person turned asking off in Settings or allowed the project for this session; the
// responder closes it when its 2 minutes run out (no answer counts as no). Deny has the focus, and Escape or a click
// outside is Deny: a public link is made only on a deliberate yes.
import { useId, useSyncExternalStore } from "react";
import { Dialog } from "@opennan/web/studio";
import type { ShareQuestion } from "./session-responder";

export type ShareAnswer = "allow" | "allow-session" | "deny";

export function agentShareMessage(projectName: string): string {
    return `Your agent wants to create a public view link for “${projectName}”. Anyone with the link can watch it. Allow?`;
}

interface Pending {
    projectName: string;
    resolve(answer: ShareAnswer): void;
}

/** The open question (at most one: a newer one denies the older). */
export function createShareQuestions() {
    let pending: Pending | null = null;
    const listeners = new Set<() => void>();
    const changed = () => {
        for (const listener of [...listeners]) listener();
    };
    const settle = (which: Pending | null, answer: ShareAnswer) => {
        if (!which || pending !== which) return;
        pending = null;
        which.resolve(answer);
        changed();
    };
    return {
        ask({ projectName, signal }: ShareQuestion): Promise<ShareAnswer> {
            settle(pending, "deny");
            return new Promise<ShareAnswer>((resolve) => {
                const question: Pending = { projectName, resolve };
                if (signal.aborted) {
                    resolve("deny");
                    return;
                }
                pending = question;
                signal.addEventListener("abort", () => settle(question, "deny"), { once: true });
                changed();
            });
        },
        answer(answer: ShareAnswer): void {
            settle(pending, answer);
        },
        /** The editor's session ended: an open question is no. */
        closeAll(): void {
            settle(pending, "deny");
        },
        current: (): { projectName: string } | null => (pending ? { projectName: pending.projectName } : null),
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export type ShareQuestions = ReturnType<typeof createShareQuestions>;

export function AgentShareDialog({ questions }: { questions: ShareQuestions }) {
    const question = useSyncExternalStore(questions.subscribe, () => questions.current()?.projectName ?? null);
    const messageId = useId();
    if (question === null) return null;
    return (
        <Dialog title="Allow a public link?" onClose={() => questions.answer("deny")} describedBy={messageId} className="agent-share-dialog">
            <p id={messageId} className="muted" style={{ margin: 0 }} data-testid="agent-share-message">{agentShareMessage(question)}</p>
            <div className="dialog-footer agent-share-actions">
                <button type="button" className="button ghost" data-autofocus onClick={() => questions.answer("deny")}>Deny</button>
                <button type="button" className="button ghost" onClick={() => questions.answer("allow-session")}>Allow for this project during this session</button>
                <button type="button" className="button" onClick={() => questions.answer("allow")}>Allow</button>
            </div>
        </Dialog>
    );
}

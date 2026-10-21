// The editor's question before an agent makes a public share link (9c.1): the project's name, the three answers,
// Escape and the backdrop as Deny, and the question closing on its own when its time runs out.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentShareDialog, createShareQuestions, agentShareMessage } from "./agent-share-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
    const questions = createShareQuestions();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<AgentShareDialog questions={questions} />));
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    const button = (name: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name)!;
    return {
        questions, dialog, button,
        unmount() {
            act(() => root.unmount());
            host.remove();
        },
    };
}

describe("agent share question", () => {
    it("words the question with the project's name", () => {
        expect(agentShareMessage("Holiday")).toBe("Your agent wants to create a public view link for “Holiday”. Anyone with the link can watch it. Allow?");
    });

    it("shows nothing until asked, then answers Allow, Allow for this project during this session, or Deny", async () => {
        const ui = mount();
        expect(ui.dialog()).toBeNull();
        for (const [label, expected] of [["Allow", "allow"], ["Allow for this project during this session", "allow-session"], ["Deny", "deny"]] as const) {
            let answer!: Promise<string>;
            act(() => { answer = ui.questions.ask({ projectName: "Holiday", signal: new AbortController().signal }); });
            expect(ui.dialog()?.textContent).toContain("public view link for “Holiday”");
            // Deny has the focus: Enter never allows by accident.
            expect(document.activeElement?.textContent).toBe("Deny");
            await act(async () => ui.button(label).click());
            await expect(answer).resolves.toBe(expected);
            expect(ui.dialog()).toBeNull();
        }
        ui.unmount();
    });

    it("Escape is Deny; the question closes when its time runs out", async () => {
        const ui = mount();
        let answer!: Promise<string>;
        act(() => { answer = ui.questions.ask({ projectName: "A", signal: new AbortController().signal }); });
        act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        await expect(answer).resolves.toBe("deny");
        const timeUp = new AbortController();
        act(() => { answer = ui.questions.ask({ projectName: "B", signal: timeUp.signal }); });
        expect(ui.dialog()).not.toBeNull();
        act(() => timeUp.abort());
        expect(ui.dialog()).toBeNull();
        await expect(answer).resolves.toBe("deny");
        ui.unmount();
    });

    it("a second question while one is open denies the first", async () => {
        const questions = createShareQuestions();
        const first = questions.ask({ projectName: "A", signal: new AbortController().signal });
        const second = questions.ask({ projectName: "B", signal: new AbortController().signal });
        await expect(first).resolves.toBe("deny");
        expect(questions.current()?.projectName).toBe("B");
        questions.answer("allow");
        await expect(second).resolves.toBe("allow");
        expect(questions.current()).toBeNull();
    });

    it("closeAll answers an open question no (the editor's session ended)", async () => {
        const questions = createShareQuestions();
        const open = questions.ask({ projectName: "A", signal: new AbortController().signal });
        questions.closeAll();
        await expect(open).resolves.toBe("deny");
        expect(questions.current()).toBeNull();
    });
});

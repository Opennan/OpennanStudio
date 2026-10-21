// Dialog focus behavior: initial focus, Tab trap, focus restore, description, Escape for the topmost dialog only.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfirmDialog, Dialog } from "./dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
});

const press = (key: string, shiftKey = false) => act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
});
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

function Harness({ onClose, nested = false }: { onClose(): void; nested?: boolean }) {
    const [open, setOpen] = useState(false);
    const [inner, setInner] = useState(false);
    return createElement("div", null,
        createElement("button", { onClick: () => setOpen(true) }, "Open"),
        open && createElement(Dialog, { title: "Settings", onClose: () => { onClose(); setOpen(false); }, describedBy: "desc" },
            createElement("p", { id: "desc" }, "About settings"),
            createElement("button", null, "First"),
            createElement("button", { "data-autofocus": true }, "Main"),
            createElement("button", { onClick: () => setInner(true) }, "Last"),
            nested && inner && createElement(Dialog, { title: "Inner", onClose: () => undefined }, createElement("button", null, "Inner button")),
        ));
}

describe("Dialog focus", () => {
    it("focuses data-autofocus, traps Tab, restores focus, and sets aria-describedby", () => {
        const onClose = vi.fn();
        act(() => root.render(createElement(Harness, { onClose })));
        const opener = byText("Open");
        opener.focus();
        act(() => opener.click());
        expect(document.activeElement).toBe(byText("Main"));
        const dialog = document.querySelector("[role=dialog]")!;
        expect(dialog.getAttribute("aria-describedby")).toBe("desc");
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        byText("Last").focus();
        press("Tab");
        expect(document.activeElement).toBe(byText("First"));
        press("Tab", true);
        expect(document.activeElement).toBe(byText("Last"));
        press("Escape");
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[role=dialog]")).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it("focuses the first focusable without data-autofocus", () => {
        act(() => root.render(createElement(ConfirmDialog, { title: "Delete?", message: "Gone for good", confirmLabel: "Delete", onConfirm: vi.fn(), onCancel: vi.fn() })));
        expect(document.activeElement).toBe(byText("Delete"));
        const dialog = document.querySelector("[role=dialog]")!;
        expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toBe("Gone for good");
    });

    it("gives Escape to the topmost dialog only", () => {
        const onClose = vi.fn();
        act(() => root.render(createElement(Harness, { onClose, nested: true })));
        act(() => byText("Open").click());
        act(() => byText("Last").click());
        expect(document.activeElement).toBe(byText("Inner button"));
        press("Escape");
        expect(onClose).not.toHaveBeenCalled();
    });
});

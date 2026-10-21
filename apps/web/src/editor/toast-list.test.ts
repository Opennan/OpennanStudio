import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ToastList } from "./toast-list";

describe("ToastList", () => {
    it("renders an action button that runs the action and dismisses the toast", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const retry = vi.fn();
        const dismiss = vi.fn();
        act(() => {
            root.render(createElement(ToastList, {
                toasts: [{ id: "t1", kind: "error", message: "Upscale failed. You were not charged.", action: { label: "Retry", run: retry } }],
                onDismiss: dismiss,
            }));
        });
        const button = host.querySelector<HTMLButtonElement>(".toast-action")!;
        expect(button.textContent).toBe("Retry");
        act(() => button.click());
        expect(retry).toHaveBeenCalledTimes(1);
        expect(dismiss).toHaveBeenCalledWith("t1");
        act(() => root.unmount());
        host.remove();
    });
});

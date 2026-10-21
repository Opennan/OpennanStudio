import { act } from "react";
import { createRoot } from "react-dom/client";
import { SettingsAddonsView } from "./settings-addons";
import { createTestBridge } from "./test-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setInput(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("desktop settings", () => {
    it("saves keys write-only and the custom command", async () => {
        const { bridge } = createTestBridge();
        let set = false;
        bridge.secrets.list = vi.fn(async () => [{ name: "OPENAI_API_KEY" as const, set }]);
        bridge.secrets.set = vi.fn(async () => { set = true; });
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        act(() => root.render(<SettingsAddonsView bridge={bridge} />));
        await flush();
        expect(host.querySelector('[data-testid="secret-OPENAI_API_KEY"]')?.textContent).toBe("Not set");
        const keyInput = host.querySelector('input[type="password"]') as HTMLInputElement;
        act(() => setInput(keyInput, "sk-secret"));
        await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click());
        await flush();
        expect(bridge.secrets.set).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-secret");
        expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
        expect(host.querySelector('[data-testid="secret-OPENAI_API_KEY"]')?.textContent).toBe("Set");
        expect(host.innerHTML).not.toContain("sk-secret");

        act(() => setInput(host.querySelector('input[aria-label="Custom command"]') as HTMLInputElement, "aider --yes"));
        await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Save command")!.click());
        expect(bridge.settings.update).toHaveBeenCalledWith({ terminalCustomCommand: "aider --yes" });
        expect(host.textContent).toContain("/u/mcp/token");
        act(() => root.unmount());
        host.remove();
    });

    it("offers \"Let agents create share links without asking\", off by default (9c.1)", async () => {
        const { bridge } = createTestBridge();
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        act(() => root.render(<SettingsAddonsView bridge={bridge} />));
        await flush();
        const toggle = host.querySelector('input[type="checkbox"][aria-describedby]') as HTMLInputElement;
        expect(toggle.closest("label")?.textContent).toContain("Let agents create share links without asking");
        expect(toggle.checked).toBe(false);
        expect(host.textContent).toContain("asks you before an agent makes a public view link");
        await act(async () => toggle.click());
        expect(bridge.settings.update).toHaveBeenCalledWith({ agentSharesWithoutAsking: true });
        act(() => root.unmount());
        host.remove();
    });
});

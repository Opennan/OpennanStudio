import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChatState } from "../shared/agent-chat";
import { AgentChatPanel } from "./agent-chat-panel";
import { createTestBridge } from "./test-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps the composer disabled until a reopened conversation has loaded", async () => {
    const { bridge } = createTestBridge();
    let resolve!: (state: ChatState) => void;
    bridge.chat.state = vi.fn(() => new Promise<ChatState>((done) => { resolve = done; }));
    bridge.chat.availability = vi.fn(async () => [{ profile: "claude" as const, installed: true, subscription: true, message: "Signed in with your subscription" }]);
    bridge.mcp.info = vi.fn(async () => ({ running: true, projectId: "local-test", url: "http://127.0.0.1:4319/mcp", port: 4319, tokenFile: "/test/token", configs: { claude: "{}", codex: "", gemini: "{}" } }));
    window.opennan = bridge;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<AgentChatPanel projectId="local-test" projectName="Test" />));
        const input = host.querySelector("textarea")!;
        expect(input.disabled).toBe(true);
        await act(async () => resolve({ projectId: "local-test", profile: "claude", messages: [], running: false, stopping: false, error: null }));
        expect(input.disabled).toBe(false);
    } finally {
        act(() => root.unmount());
        host.remove();
    }
});

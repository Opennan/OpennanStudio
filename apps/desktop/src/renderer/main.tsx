import "@opennan/timeline-react/styles.css";
import "@opennan/web/styles.css";
import "./desktop.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioApp } from "@opennan/web/studio";
import { createDesktopAccount } from "./desktop-account";
import { createDesktopProviderSettings, createDesktopProviders } from "./desktop-providers";
import { createDesktopRuntime } from "./desktop-runtime";
import { serveExportBridgePorts } from "./export-bridge-ports";
import { AgentChatPanel } from "./agent-chat-panel";
import { EditorAddons } from "./editor-addons";
import { createDesktopExportPlatform } from "./export-platform";
import { SettingsAddons } from "./settings-addons";

serveExportBridgePorts();
const bridge = window.opennan;
const providers = createDesktopProviders(bridge);
const runtime = createDesktopRuntime(bridge, {
    appOrigin: window.location.origin,
    ui: { EditorAddons, SettingsAddons, AiPanel: AgentChatPanel },
    exportPlatform: createDesktopExportPlatform(bridge),
    providers: providers.registry,
    account: createDesktopAccount(bridge),
    providerSettings: createDesktopProviderSettings(bridge, { onKeysChanged: () => providers.refreshCloud() }),
    capabilityNote: (capability) => (capability === "audio.transcribe" ? providers.unavailableReason() : null),
});

createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <StudioApp runtime={runtime} />
    </StrictMode>,
);

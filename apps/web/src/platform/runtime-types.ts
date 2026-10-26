// What the editor shell needs from its host: a backend, a media environment, storage, and the platform
// seams (export, UI add-ons, media size limit, debug hooks). The web app builds one in studio-runtime.ts;
// apps/desktop builds its own and imports the shell from "@opennan/web/studio". Nothing here imports a
// platform implementation.
import type { ComponentType } from "react";
import type { ProviderCapability, ProviderRegistry } from "@opennan/provider-sdk";
import type { MediaLibraryBackend, ProjectCatalog, TimelineBackend } from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";
import type { TimelineMarkerStorage } from "@opennan/timeline-react";
import type { AccountPlatform, ProviderPlatform } from "../account/account-types";
import type { ExportPlatform } from "./export-platform";
import type { StorageGuard } from "./storage";

export const MARKER_STORAGE_PREFIX = "opennan-studio:markers:";

export type StudioBackend = TimelineBackend & ProjectCatalog & MediaLibraryBackend;

export interface StudioUi {
    /** Subscription chat hosted by the desktop app. */
    AiPanel?: ComponentType<{ projectId: string; projectName: string }>;
    /** Rendered inside <TimelineProvider> after the editor workspace (desktop: agent session, terminal, media banner). */
    EditorAddons?: ComponentType<{ projectId: string }>;
    /** Rendered at the end of the settings screen (desktop: API keys, terminal, MCP). */
    SettingsAddons?: ComponentType;
}

export interface StudioRuntime {
    platform: "web" | "desktop";
    backend: StudioBackend;
    media: MediaEnvironment;
    markerStorage: TimelineMarkerStorage;
    storage: StorageGuard;
    exportPlatform: ExportPlatform;
    /**
     * AI providers (spec §5.4): ai.run and capability-gated UI route through it. Web registers none; desktop
     * registers the on-device provider (audio.transcribe) when its whisper.cpp is bundled.
     */
    providers: ProviderRegistry;
    /** Sign in with OpenNan: status (never a key), the sign-in flow, the console links, and account notices. */
    account: AccountPlatform;
    /** Per-capability routing and bring-your-own provider keys (Settings → AI providers). */
    providerSettings: ProviderPlatform;
    /** Why a capability has no provider on this platform (desktop: "no whisper.cpp for win32-arm64"), shown with the guidance. */
    capabilityNote?(capability: ProviderCapability): string | null;
    ui: StudioUi;
    /** Largest media file an import accepts. */
    maxMediaBytes: number;
    /** Timeline debug hooks and window.__studio (e2e builds and dev only). */
    debug: boolean;
    /** Drops per-project view state kept outside the backend (markers). */
    forgetProject(projectId: string): void;
    /**
     * Marks the project open in an editor. The returned release closes it
     * (ProjectCatalog.closeProject) one task later if no editor holds it by then, so
     * StrictMode's mount-unmount-mount does not close a project that stays open.
     */
    retainProject(projectId: string): () => void;
}

/** retainProject over a hold count per project; `close` runs one task after the last hold is released. */
export function createProjectHolds(close: (projectId: string) => void): (projectId: string) => () => void {
    const holds = new Map<string, number>();
    return (projectId) => {
        holds.set(projectId, (holds.get(projectId) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            holds.set(projectId, (holds.get(projectId) ?? 1) - 1);
            setTimeout(() => {
                if ((holds.get(projectId) ?? 0) > 0) return;
                holds.delete(projectId);
                close(projectId);
            }, 0);
        };
    };
}

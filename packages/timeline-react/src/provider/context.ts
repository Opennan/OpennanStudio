import { createContext } from "react";
import type { EditorStore, SourceSize, TimelineBackend, TimelineController, TimelineTheme } from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";
import type { TimelineTranslate } from "../i18n/format";
import type { TimelineToastApi } from "./toast";
import type {
    ChatEditRequest, ChatReference, ClipEditRequest, InspectTarget, MusicPanelRequest, SceneDetailsRequest, SceneEditRequest,
} from "../types/host-requests";
import type { UploadedMedia } from "@opennan/timeline-core";
import type { TimelineAiHost } from "../ai/ai-host";

export interface TimelineHostCallbacks {
    onOpenChatEdit?(request: ChatEditRequest): void;
    onOpenMusicPanel?(request: MusicPanelRequest): void;
    onOpenSceneDetails?(request: SceneDetailsRequest): void;
    onOpenClipEdit?(request: ClipEditRequest): void;
    onOpenSceneEdit?(request: SceneEditRequest): void;
    onSuggestChatReference?(reference: ChatReference): void;
    onSaveToSources?(media: UploadedMedia): void;
    onInspect?(target: InspectTarget): void;
}

/**
 * Clip boxes at scale 1 in frame fractions, as the preview laid them out (phase 10d): the preview sets `current`, the
 * controller's motion tracker reads it when tracking.apply needs a follower's box.
 */
export interface OverlayAnchorsRegistry {
    current: ((clipIds: string[]) => Record<string, SourceSize | undefined>) | null;
}

export interface TimelineContextValue {
    controller: TimelineController;
    store: EditorStore;
    backend: TimelineBackend;
    projectId: string;
    media: MediaEnvironment;
    translate: TimelineTranslate;
    locale: string;
    theme: TimelineTheme;
    toast: TimelineToastApi;
    callbacks: TimelineHostCallbacks;
    portalContainer: HTMLElement | null;
    debugHooks: boolean;
    overlayAnchors: OverlayAnchorsRegistry;
    /** AI in the editor (phase 11): the host's AI tools, or null (local tools only). */
    ai: TimelineAiHost | null;
}

export const TimelineContext = createContext<TimelineContextValue | null>(null);

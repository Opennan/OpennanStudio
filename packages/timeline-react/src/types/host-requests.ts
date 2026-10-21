// Host-facing request types that replace window CustomEvents.
// ChatReference: copied from opennan frontend lib/chat-references.ts:8-30.
export type ChatReferenceType = "scene" | "shot" | "timeline_clip" | "media";

export interface ChatReference {
    type: ChatReferenceType;
    label?: string;
    sceneId?: string;
    sceneOrder?: number;
    shotIndex?: number;
    clipId?: string;
    trackType?: string;
    trackIndex?: number;
    startTime?: number;
    endTime?: number;
    mediaUrl?: string | null;
    prompt?: string | null;
    duration?: number | string | null;
    editKind?: "image" | "video" | "audio" | "text";
}

// lib/chat-edit-request.ts:8-15 (was the open-chat-edit window event)
export type ChatEditKind = "image" | "video" | "audio" | "text";
export interface ChatEditRequest {
    kind: ChatEditKind;
    reference: ChatReference;
    prompt?: string;
}

// lib/music-panel-request.ts:11-15 (was the music-properties-mode window event)
export interface MusicPanelRequest {
    mode: "music" | "sfx";
    trackIndex?: number;
    startTime?: number;
}

/** Was setScrollToShot + setLeftPanelTab("properties") at nle-timeline.tsx:3878-3880. */
export interface SceneDetailsRequest {
    sceneId: string;
    shotIndex: number;
}

/** Was the open-clip-edit window event at canvas-timeline.tsx:4337-4357. */
export interface ClipEditRequest {
    clipId: string;
    kind: "video" | "image" | "audio";
}

/** Was the open-scene-edit-video window event at canvas-timeline.tsx:4099-4101. */
export interface SceneEditRequest {
    sceneId: string;
    tool: string;
}

/** Replaces the store's panel-tab switching on selection. */
export type InspectTarget =
    | { kind: "clip"; id: string }
    | { kind: "scene"; id: string }
    | { kind: "transition"; id: string; transitionKind: "clip" | "scene" }
    | { kind: "audio"; target: "music" | { sceneId: string; type: "voiceover" } };

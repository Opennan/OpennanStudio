// Compact, JSON-safe views of clips, scenes, and media for tool results.
import type { ControllerSnapshot, SceneData, TimelineClip } from "@opennan/timeline-core";
import { sceneSpan, scenesInOrder } from "../args";

const sec = (n: number) => Math.round(n * 1000) / 1000;

export function clipSummary(clip: TimelineClip, includeMedia = false): Record<string, unknown> {
    return {
        id: clip.id,
        trackType: clip.trackType,
        trackIndex: clip.trackIndex,
        startTime: sec(clip.startTime),
        endTime: sec(clip.endTime),
        label: clip.label,
        mediaType: clip.mediaType,
        textContent: clip.textContent ? clip.textContent.slice(0, 200) : null,
        sceneId: clip.sceneId,
        locked: clip.locked,
        volume: clip.volume,
        effects: (clip.effects ?? []).map((e) => ({ id: e.id, effectId: e.effectId, enabled: e.enabled })),
        ...(includeMedia ? { mediaUrl: clip.mediaUrl } : {}),
    };
}

export interface OrderedScene {
    scene: SceneData;
    sceneOrder: number;
    start: number;
    duration: number;
}

export function orderedScenes(snapshot: ControllerSnapshot): OrderedScene[] {
    return scenesInOrder(snapshot.scenes).map((scene, i) => ({ scene, sceneOrder: i + 1, ...sceneSpan(snapshot, scene) }));
}

export function parseShots(scene: SceneData): Record<string, unknown>[] {
    try {
        const parsed = JSON.parse(scene.shotBreakdown || "[]");
        return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === "object") : [];
    } catch {
        return [];
    }
}

export function sceneSummary(entry: OrderedScene, options: { includeMedia?: boolean; includeShots?: boolean } = {}): Record<string, unknown> {
    const { scene } = entry;
    return {
        sceneOrder: entry.sceneOrder,
        id: scene.id,
        start: sec(entry.start),
        duration: sec(entry.duration),
        trackIndex: scene.trackIndex ?? 1,
        caption: scene.caption,
        cardType: scene.cardType ?? null,
        status: scene.status,
        transition: scene.transition,
        visualTransition: scene.visualTransition ?? null,
        audioText: scene.audioText,
        shotCount: parseShots(scene).length,
        ...(options.includeShots
            ? { shots: parseShots(scene).map((shot, index) => ({ index, prompt: shot.prompt ?? null, duration: shot.duration ?? null, speech: shot.speech ?? null })) }
            : {}),
        ...(options.includeMedia
            ? { videoUrl: scene.videoUrl, sourceVideoUrl: scene.sourceVideoUrl ?? null, startImageUrl: scene.startImageUrl, audioUrl: scene.audioUrl }
            : {}),
    };
}

export interface MediaUse {
    type: "clip" | "scene";
    id: string;
    field: string;
    label: string | null;
}

export interface MediaRef {
    url: string;
    kind: "video" | "audio" | "image" | "other";
    usedBy: MediaUse[];
}

const EXTENSIONS: Array<[RegExp, MediaRef["kind"]]> = [
    [/\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i, "video"],
    [/\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?|#|$)/i, "audio"],
    [/\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i, "image"],
];

function kindOf(url: string, fallback: MediaRef["kind"]): MediaRef["kind"] {
    for (const [pattern, kind] of EXTENSIONS) if (pattern.test(url)) return kind;
    return fallback;
}

export function collectMedia(snapshot: ControllerSnapshot): MediaRef[] {
    const byUrl = new Map<string, MediaRef>();
    const add = (url: string | null | undefined, fallback: MediaRef["kind"], use: MediaUse) => {
        if (!url) return;
        const ref = byUrl.get(url) ?? { url, kind: kindOf(url, fallback), usedBy: [] };
        ref.usedBy.push(use);
        byUrl.set(url, ref);
    };
    for (const clip of snapshot.clips) {
        const fallback = clip.trackType === "audio" ? "audio" : clip.trackType === "video" ? "video" : clip.trackType === "sticker" ? "image" : "other";
        add(clip.mediaUrl, fallback, { type: "clip", id: clip.id, field: "mediaUrl", label: clip.label });
        add(clip.thumbnailUrl, "image", { type: "clip", id: clip.id, field: "thumbnailUrl", label: clip.label });
    }
    for (const scene of snapshot.scenes) {
        const use = (field: string): MediaUse => ({ type: "scene", id: scene.id, field, label: scene.caption || null });
        add(scene.videoUrl, "video", use("videoUrl"));
        add(scene.sourceVideoUrl, "video", use("sourceVideoUrl"));
        add(scene.startImageUrl, "image", use("startImageUrl"));
        add(scene.endImageUrl, "image", use("endImageUrl"));
        add(scene.audioUrl, "audio", use("audioUrl"));
    }
    return [...byUrl.values()];
}

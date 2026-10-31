// "Put on timeline": the story's clips, title and music as timeline-core's reel layout (9:16, title above the 16:9
// film). A story placed before is replaced (its scenes and clips go first), so placing it again never doubles it.
import type { ReelLayoutInput, ReelLayoutOutcome } from "@opennan/timeline-core";
import type { StoryFilm } from "./types";
import { shotSeconds } from "./validate";

export type ReelInputResult = { ok: true; input: ReelLayoutInput } | { ok: false; error: string; missing: string[] };

/** The reel layout of the story's clips (every shot needs its clip), with the music when it has one. */
export function reelInputOf(story: StoryFilm): ReelInputResult {
    const missing = story.shots.filter((s) => !s.clip).map((s) => s.id);
    if (missing.length > 0) return { ok: false, error: `Animate ${missing.length === 1 ? "shot" : "shots"} ${missing.join(", ")} first.`, missing };
    const keepMotion = story.source?.kind === "copy" && story.source.keepMotion === true;
    const input: ReelLayoutInput = {
        title: story.title,
        clips: story.shots.map((shot, i) => {
            const clip = shot.clip!;
            // The shot's own length, unless the clip came back shorter (a scene never runs past its media). A copy that
            // keeps the original motion keeps the original cut too: a shot runs as long as its real shot.
            const real = keepMotion && shot.source ? Math.max(1, shot.source.end - shot.source.start) : Infinity;
            const seconds = Math.min(shotSeconds(shot), real, clip.durationSeconds && clip.durationSeconds > 0 ? clip.durationSeconds : shotSeconds(shot));
            return { mediaUrl: clip.url, durationSeconds: seconds, label: `${i + 1}. ${shot.id}`, ...(clip.width && clip.height ? { width: clip.width, height: clip.height } : {}) };
        }),
        music: story.musicAsset ? { mediaUrl: story.musicAsset.url, ...(story.musicAsset.durationSeconds ? { durationSeconds: story.musicAsset.durationSeconds } : {}) } : null,
        ...(story.assembled ? { replace: { sceneIds: story.assembled.sceneIds, clipIds: story.assembled.clipIds } } : {}),
    };
    return { ok: true, input };
}

/** The story after a layout: what it placed, so the next one replaces it. */
export function withAssembled(story: StoryFilm, outcome: Pick<ReelLayoutOutcome, "sceneIds" | "titleClipId" | "musicClipId">): StoryFilm {
    const clipIds = [outcome.titleClipId, outcome.musicClipId].filter((id): id is string => typeof id === "string");
    return { ...story, assembled: { sceneIds: [...outcome.sceneIds], clipIds } };
}

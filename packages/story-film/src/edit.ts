// Edits of a story that already has files: a new version of the story keeps every file made for the characters and
// shots that keep their ids (a changed text shows them as changed, never deletes them), and its costs and placement.
import { isFlagged, isStale, storyItems } from "./pipeline";
import { STORY_STEPS, type StoryFilm, type StoryStep } from "./types";

/** `next` with the files `previous` made for the same ids (next's own files win), its costs, settings and placement. */
export function mergeStory(previous: StoryFilm | null, next: StoryFilm): StoryFilm {
    if (!previous) return next;
    const characters = next.characters.map((c) => {
        const old = previous.characters.find((p) => p.id === c.id);
        return c.sheet || !old?.sheet ? c : { ...c, sheet: old.sheet };
    });
    const shots = next.shots.map((s) => {
        const old = previous.shots.find((p) => p.id === s.id);
        if (!old) return s;
        const keyframe = !s.keyframe && old.keyframe ? { keyframe: old.keyframe, ...(old.check ? { check: old.check } : {}) } : {};
        // A shot's place in the copied video stays with its id (the editor does not show it).
        return { ...s, ...keyframe, ...(!s.clip && old.clip ? { clip: old.clip } : {}), ...(!s.source && old.source ? { source: old.source } : {}) };
    });
    const merged: StoryFilm = { ...next, characters, shots };
    if (!merged.musicAsset && previous.musicAsset) merged.musicAsset = previous.musicAsset;
    if (!merged.settings && previous.settings) merged.settings = previous.settings;
    if (!merged.assembled && previous.assembled) merged.assembled = previous.assembled;
    merged.spentUsd = Math.max(previous.spentUsd ?? 0, next.spentUsd ?? 0) || undefined;
    if (merged.spentUsd === undefined) delete merged.spentUsd;
    return merged;
}

const newer = <T extends { at?: string } | null | undefined>(a: T, b: T): T => {
    if (!a) return b;
    if (!b) return a;
    return (b.at ?? "") > (a.at ?? "") ? b : a;
};

/**
 * `base` (the story as it is stored now, perhaps edited while a run went) with every asset of `from` (the run's story)
 * that is newer than base's own; what was spent is the larger of the two.
 */
export function withNewerAssets(base: StoryFilm, from: StoryFilm): StoryFilm {
    const characters = base.characters.map((c) => {
        const sheet = newer(c.sheet ?? null, from.characters.find((f) => f.id === c.id)?.sheet ?? null);
        return sheet ? { ...c, sheet } : c;
    });
    const shots = base.shots.map((s) => {
        const other = from.shots.find((f) => f.id === s.id);
        const keyframe = newer(s.keyframe ?? null, other?.keyframe ?? null);
        const clip = newer(s.clip ?? null, other?.clip ?? null);
        // The cast check that looked at the keyframe kept (none when neither did).
        const check = [s.check, other?.check].find((c) => c && keyframe && c.keyframeUrl === keyframe.url) ?? null;
        const next = { ...s, ...(keyframe ? { keyframe } : {}), ...(clip ? { clip } : {}) };
        if (check) next.check = check;
        else delete next.check;
        return next;
    });
    const musicAsset = newer(base.musicAsset ?? null, from.musicAsset ?? null);
    const spentUsd = Math.max(base.spentUsd ?? 0, from.spentUsd ?? 0);
    return { ...base, characters, shots, ...(musicAsset ? { musicAsset } : {}), ...(spentUsd > 0 ? { spentUsd } : {}) };
}

export interface StepProgress {
    step: StoryStep;
    made: number;
    total: number;
    /** Ids without a file yet. */
    missing: string[];
    /** Ids whose file came from an older text or reference. */
    changed: string[];
    /** Frames: shots whose cast check found a character off their sheet (or could not tell): check these. */
    flagged: string[];
}

/** How far each step is: what is made, missing, and changed since it was made. */
export function storyProgress(story: StoryFilm): StepProgress[] {
    return STORY_STEPS.map((step) => {
        const items = storyItems(story, step);
        return {
            step, made: items.filter((i) => i.asset).length, total: items.length,
            missing: items.filter((i) => !i.asset).map((i) => i.id), changed: items.filter((i) => isStale(i)).map((i) => i.id),
            flagged: step === "frames" ? story.shots.filter(isFlagged).map((s) => s.id) : [],
        };
    });
}

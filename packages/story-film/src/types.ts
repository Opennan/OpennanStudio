// The story film (story.json): what the film is (title, style, cast, shots, music) and what has been made for it so far
// (each cast sheet, keyframe, clip and the music as a project media asset, with the inputs that made it and its cost).
// The story lives on the project (ProjectMeta.storyFilmJson), so the editor, agents and a re-run all see the same
// assets and never pay twice for one.

import type { ReferenceVideoLimits } from "@opennan/provider-sdk";

export const STORY_FILM_VERSION = 1;

/** How the film is drawn: picks the medium words of the keyframe and motion prompts ("2d" is the proven recipe). */
export const STORY_MEDIUMS = ["2d", "3d", "stop-motion", "anime"] as const;
export type StoryMedium = (typeof STORY_MEDIUMS)[number];

/** One made file: a project media URL and the inputs that made it (a changed text leaves it, marked changed). */
export interface StoryAsset {
    url: string;
    /** Hash of the request that made it (prompt, model, references): differs once the text it came from changes. */
    key: string;
    costUsd?: number | null;
    model?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    /** ISO time it was made. */
    at?: string;
}

export interface StoryCharacter {
    /** Short id the shots' cast lists use ("theo"). */
    id: string;
    name: string;
    /** What stays the same in every shot: build, hair, clothes, colours. Restated in every keyframe prompt. */
    look: string;
    sheet?: StoryAsset | null;
}

/**
 * The cast check of a keyframe: a vision call compared it with the cast's sheets (hair, outfit, colours). It belongs
 * to the keyframe it looked at; a new keyframe has none until it is checked.
 */
export interface StoryCastCheck {
    /** The keyframe it looked at. */
    keyframeUrl: string;
    /** Every character of the shot matched their sheet. */
    ok: boolean;
    /** Keyframes drawn for the shot in that run (the first one plus its redraws). */
    tries: number;
    /** The characters that did not match on the last look, and why (empty when ok). */
    misses: Array<{ id: string; reason: string }>;
    /** The last look gave no answer (the call failed or its answer did not read): nobody checked this keyframe. */
    unread?: boolean;
    /** What the checks cost, in dollars. */
    costUsd?: number;
    at?: string;
}

/**
 * Where a copied shot sits in the source video (seconds), and its clip: that range cut out as a project video. A remake
 * sends the clip as the shot's reference video, so the new shot keeps the real shot's motion, blocking and camera.
 */
export interface StoryShotSource {
    start: number;
    end: number;
    /** The range as its own project video (absent: the range of the story's source video is sent). */
    clip?: string;
}

export interface StoryShot {
    id: string;
    /** Character ids in the shot, in reference order (their sheets go to the keyframe in this order). */
    cast: string[];
    /** The still: who is where, doing what, in which place and light. */
    frame: string;
    /** What moves from that still (it must match what the frame shows) and the camera. */
    motion: string;
    /** 4 to 15 (default 5). */
    seconds?: number;
    keyframe?: StoryAsset | null;
    /** The keyframe's cast check (a flagged shot shows "check this shot"). */
    check?: StoryCastCheck | null;
    clip?: StoryAsset | null;
    /** A copied video's shot this one remakes. */
    source?: StoryShotSource;
}

export interface StorySettings {
    imageModel?: string;
    /** Image size of sheets and keyframes ("2K"). */
    imageSize?: string;
    videoModel?: string;
    quality?: string;
    /** The video model's lengths (seconds), as the provider lists them: a remake rounds the shot's length to one. */
    videoDurations?: number[];
    /** The video model's reference video limits (absent: it takes none, and shots animate from their keyframes). */
    videoReference?: ReferenceVideoLimits;
}

/**
 * Where the draft came from. A copy makes an original cast and title by default; "keep" is for the user's own videos.
 * `keepMotion`: each shot is remade from its real shot (the source clip as a reference video) when the video model
 * takes reference videos; else, and when it is off, shots animate from their keyframes.
 */
export type StorySource =
    | { kind: "write" }
    | { kind: "copy"; cast: "original" | "keep"; mediaUrl?: string; link?: string; keepMotion?: boolean };

export interface StoryFilm {
    version: typeof STORY_FILM_VERSION;
    title: string;
    /** The look of every image: medium, linework, colour, light, era. Ends every image prompt. */
    style: string;
    medium?: StoryMedium;
    characters: StoryCharacter[];
    shots: StoryShot[];
    /** The music's description (an instrumental bed the film's length). */
    music: string;
    musicAsset?: StoryAsset | null;
    settings?: StorySettings;
    source?: StorySource;
    /** What the last "Put on timeline" placed (it is replaced, never doubled, when placed again). */
    assembled?: { sceneIds: string[]; clipIds: string[] } | null;
    /** What every paid step so far was charged, in dollars. */
    spentUsd?: number;
}

export type StoryStep = "cast" | "frames" | "animate" | "music";
export const STORY_STEPS: readonly StoryStep[] = ["cast", "frames", "animate", "music"];

// Reference videos of a video generation (Story film's remake: a shot of the person's video whose motion, blocking and
// camera are copied with a new cast and look). Each reference is a project media range (prepared by the host as an
// MP4 of the model's size and frame rate, then uploaded as a temporary input like any tool's media) or an https link.
// Every limit the model publishes (GET /v1/models `reference_videos`) is checked before anything is uploaded, and the
// prepared file is checked again before the task is created: a reference the server would refuse is never sent.
import { JobFailedError, parseMediaSourceRef, referenceBilledSeconds, type MediaPreparePurpose, type MediaSourceRef, type PreparedMedia, type ReferenceVideoLimits } from "@opennan/provider-sdk";
import { allowedLink, type Input } from "./inputs";

const MB = 1024 * 1024;

/** The picture shapes a reference may have (width ÷ height), as the server documents them. */
export const REFERENCE_ASPECT = Object.freeze({ min: 0.4, max: 2.5 });

/** What a call sends as one reference: a project media range, or an https link. `seconds`: its length, when known. */
export interface ReferenceVideoInput {
    source?: MediaSourceRef;
    url?: string;
    seconds?: number;
}

const CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime" };

/** The model's `reference_videos` block as limits, or undefined when it publishes none. */
export function parseReferenceLimits(raw: unknown): ReferenceVideoLimits | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const block = raw as Record<string, unknown>;
    const pos = (key: string) => (typeof block[key] === "number" && Number.isFinite(block[key]) && (block[key] as number) > 0 ? (block[key] as number) : undefined);
    const words = (key: string) => (Array.isArray(block[key]) ? (block[key] as unknown[]).filter((w): w is string => typeof w === "string" && w.length > 0 && w.length <= 32) : undefined);
    const max = pos("max_count");
    const maxSeconds = pos("max_seconds");
    if (max === undefined || maxSeconds === undefined) return undefined;
    const limits: ReferenceVideoLimits = {
        max: Math.floor(max), minSeconds: pos("min_seconds") ?? 0, maxSeconds, totalSeconds: pos("max_total_seconds") ?? maxSeconds,
        modes: words("modes")?.length ? words("modes")! : ["reference"],
    };
    const formats = words("formats");
    if (formats?.length) limits.formats = formats;
    const optional: Array<[keyof ReferenceVideoLimits, string]> = [
        ["maxMb", "max_mb"], ["minSide", "min_side"], ["maxSide", "max_side"], ["minPixels", "min_pixels"], ["minFps", "min_fps"], ["maxFps", "max_fps"], ["editMinSeconds", "edit_min_seconds"],
    ];
    for (const [field, key] of optional) {
        const value = pos(key);
        if (value !== undefined) (limits as unknown as Record<string, number>)[field] = value;
    }
    return limits;
}

/** The references an input names (`referenceVideos`: each { mediaUrl, startSeconds?, endSeconds?, seconds? } or an https link). */
export function parseReferenceVideos(input: Input, loopbackApi: boolean): ReferenceVideoInput[] {
    const raw = input.referenceVideos;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 8) throw new JobFailedError("referenceVideos must list at most 8 videos.");
    return raw.map((value, index) => {
        const where = `referenceVideos[${index}]`;
        if (typeof value === "string") {
            if (value.length > 4096 || !allowedLink(value, loopbackApi)) throw new JobFailedError(`${where} must be an https link or a project video.`);
            return { url: value };
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JobFailedError(`${where} must be an https link or a project video.`);
        const { seconds, ...rest } = value as Record<string, unknown>;
        if (seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)) throw new JobFailedError(`${where}.seconds must be the clip's length in seconds.`);
        const source = parseMediaSourceRef(rest);
        if (typeof source === "string") throw new JobFailedError(`${where}: ${source}`);
        const known = typeof seconds === "number" ? seconds : source.startSeconds !== undefined && source.endSeconds !== undefined ? source.endSeconds - source.startSeconds : undefined;
        return { source, ...(known !== undefined ? { seconds: known } : {}) };
    });
}

/** The references' total length when every one's is known (from the input), else undefined. */
export function referenceSecondsOf(input: Input): number | undefined {
    const raw = input.referenceVideos;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    let total = 0;
    for (const value of raw) {
        if (typeof value !== "object" || value === null) return undefined;
        const ref = value as Record<string, unknown>;
        const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
        const seconds = fin(ref.seconds) ? ref.seconds : fin(ref.startSeconds) && fin(ref.endSeconds) ? ref.endSeconds - ref.startSeconds : undefined;
        if (seconds === undefined || seconds <= 0) return undefined;
        total += seconds;
    }
    return total;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Why references of these lengths cannot be sent (count, each length, the total), or null. Unknown lengths pass here. */
export function referenceLengthProblem(limits: ReferenceVideoLimits, seconds: ReadonlyArray<number | undefined>, mode: string): string | null {
    if (seconds.length > limits.max) return `This model takes at most ${limits.max} reference video${limits.max === 1 ? "" : "s"}.`;
    let total = 0;
    for (const [index, length] of seconds.entries()) {
        if (length === undefined) continue;
        const which = seconds.length > 1 ? `Reference video ${index + 1}` : "The reference video";
        if (length < limits.minSeconds) return `${which} is ${round1(length)} s: the model takes ${limits.minSeconds} s at least.`;
        if (length > limits.maxSeconds) return `${which} is ${round1(length)} s: the model takes ${limits.maxSeconds} s at most.`;
        if (index === 0 && mode === "editing" && limits.editMinSeconds !== undefined && length < limits.editMinSeconds) return `An edit needs a first video of ${limits.editMinSeconds} s at least.`;
        total += length;
    }
    if (total > limits.totalSeconds + 1e-9) return `The reference videos run ${round1(total)} s: the model takes ${limits.totalSeconds} s in all.`;
    return null;
}

/** Why a prepared reference cannot be sent (its length, size, picture, frame rate), or null. */
export function preparedReferenceProblem(limits: ReferenceVideoLimits, prepared: PreparedMedia): string | null {
    if (limits.maxMb !== undefined && prepared.sizeBytes > limits.maxMb * MB) return `The reference clip is ${(prepared.sizeBytes / MB).toFixed(1)} MB: the model takes ${limits.maxMb} MB at most.`;
    const types = (limits.formats ?? ["mp4"]).map((f) => CONTENT_TYPES[f.toLowerCase()]).filter(Boolean);
    if (types.length > 0 && !types.includes(prepared.contentType)) return `The reference clip must be ${(limits.formats ?? ["mp4"]).map((f) => f.toUpperCase()).join(" or ")}; this app made ${prepared.contentType}.`;
    const { width, height } = prepared;
    if (width && height) {
        const short = Math.min(width, height);
        const long = Math.max(width, height);
        if (limits.minSide !== undefined && short < limits.minSide) return `The reference clip is ${width}x${height}: each side must be ${limits.minSide} px at least.`;
        if (limits.maxSide !== undefined && long > limits.maxSide) return `The reference clip is ${width}x${height}: each side must be ${limits.maxSide} px at most.`;
        if (limits.minPixels !== undefined && width * height < limits.minPixels) return `The reference clip is ${width}x${height}: the model needs ${limits.minPixels.toLocaleString("en-US")} pixels a frame at least (about 640x640 or 854x480).`;
        const aspect = width / height;
        if (aspect < REFERENCE_ASPECT.min || aspect > REFERENCE_ASPECT.max) return `The reference clip is ${width}x${height}: its shape must be between 2:5 and 5:2.`;
    }
    const fps = prepared.frameRate;
    if (fps !== undefined && Number.isFinite(fps) && fps > 0) {
        if (limits.minFps !== undefined && fps < limits.minFps - 0.5) return `The reference clip runs at ${round1(fps)} fps: the model takes ${limits.minFps} fps at least.`;
        if (limits.maxFps !== undefined && fps > limits.maxFps + 0.5) return `The reference clip runs at ${round1(fps)} fps: the model takes ${limits.maxFps} fps at most.`;
    }
    return null;
}

/** What the host prepares for one reference: the model's container, size and frame rate, no sound. */
export function referencePurpose(limits: ReferenceVideoLimits): MediaPreparePurpose {
    const types = (limits.formats ?? ["mp4"]).map((f) => CONTENT_TYPES[f.toLowerCase()]).filter((t): t is string => Boolean(t));
    return {
        output: "video", maxBytes: (limits.maxMb ?? 60) * MB, maxSeconds: limits.maxSeconds, contentTypes: types.length > 0 ? types : ["video/mp4"],
        ...(limits.minPixels !== undefined ? { minPixels: limits.minPixels } : {}),
        ...(limits.minFps !== undefined || limits.maxFps !== undefined ? { frameRate: { min: limits.minFps ?? 1, max: limits.maxFps ?? 120 } } : {}),
    };
}

/**
 * A prepared reference came out longer than the length it was priced at (more billed seconds): nothing is sent, so
 * the run never costs more than the price shown.
 */
export function longerThanPriced(limits: ReferenceVideoLimits, priced: number | undefined, measured: number | undefined): boolean {
    if (priced === undefined || measured === undefined) return false;
    return referenceBilledSeconds(measured, limits) > referenceBilledSeconds(priced, limits);
}

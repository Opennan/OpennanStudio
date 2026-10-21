// The fal.ai provider (spec §5.6): a reference community adapter. Bring your own key; fal bills you directly.
// Jobs use fal's queue API: POST https://queue.fal.run/<model> answers a request id with status, response, and
// cancel URLs (all must stay on queue.fal.run); the status URL is polled until COMPLETED, then the response holds
// the media links. The key goes only to queue.fal.run and fal's storage API (rest.alpha.fal.ai), as
// "Authorization: Key …". Project media (phase 11) is made by the host's MediaPreparer and uploaded to fal storage:
// POST …/storage/upload/initiate answers an upload_url (PUT the bytes there, no key) and the file_url fal reads.
import {
    CapabilityUnavailableError, JobFailedError, createJob, parseMediaSourceRef,
    type CapabilityOutput, type GeneratedMedia, type JobContext, type MediaPreparePurpose, type MediaPreparer, type Provider, type ProviderCapability, type ProviderModel,
} from "@opennan/provider-sdk";

export const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
export const FAL_STORAGE_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate";
export const FAL_PROVIDER_ID = "fal";
export const FAL_CAPABILITIES: ProviderCapability[] = ["image.generate", "video.text-to-video", "video.image-to-video", "audio.isolate-voice", "video.upscale"];
export const FAL_PREPARE_UNAVAILABLE = "This app cannot prepare local media for fal.ai yet: use an https link.";

/** Models offered per capability; the first is the default. */
export const FAL_MODELS: Partial<Record<ProviderCapability, ProviderModel[]>> = {
    "image.generate": [
        { id: "fal-ai/flux/schnell", label: "FLUX.1 [schnell]", default: true },
        { id: "fal-ai/flux/dev", label: "FLUX.1 [dev]" },
    ],
    "video.text-to-video": [{ id: "fal-ai/kling-video/v2.1/standard/text-to-video", label: "Kling 2.1 Standard", default: true }],
    "video.image-to-video": [{ id: "fal-ai/kling-video/v2.1/standard/image-to-video", label: "Kling 2.1 Standard", default: true }],
    "audio.isolate-voice": [{ id: "fal-ai/elevenlabs/audio-isolation", label: "ElevenLabs audio isolation", default: true }],
    "video.upscale": [{ id: "fal-ai/bytedance-upscaler/upscale/video", label: "ByteDance video upscaler", default: true }],
};

const MB = 1024 * 1024;
/** What fal's tools take from a project media. */
export const FAL_MEDIA_PURPOSES = {
    audio: { output: "audio", sampleRate: 44_100, maxBytes: 200 * MB, maxSeconds: 600, contentTypes: ["audio/wav"] },
    video: { output: "video", maxBytes: 500 * MB, maxSeconds: 120, contentTypes: ["video/mp4", "video/webm"] },
    image: { output: "image", maxBytes: 20 * MB, contentTypes: ["image/png", "image/jpeg", "image/webp"] },
} as const satisfies Record<string, MediaPreparePurpose>;

export const FAL_KEY_MISSING = "Add your fal.ai key in Settings → AI providers to use fal.";
const POLL_MS = 1500;
const MODEL_ID = /^[a-z0-9-]+(\/[a-z0-9._-]+){1,5}$/;

export class FalKeyError extends CapabilityUnavailableError {
    constructor(capability: ProviderCapability, message: string) {
        super(capability);
        this.name = "FalKeyError";
        this.message = message;
    }
}

export interface FalProviderOptions {
    /** The user's fal key (null when none is stored). */
    getKey(): string | null | Promise<string | null>;
    fetch?: typeof globalThis.fetch;
    pollMs?: number;
    /** Makes the file for a project media input (MediaSourceRef); without it, media inputs must be https links. */
    prepareMedia?: MediaPreparer;
}

interface QueueAnswer {
    request_id?: unknown;
    status_url?: unknown;
    response_url?: unknown;
    cancel_url?: unknown;
}

const IMAGE_SIZES: Record<string, string> = { "16:9": "landscape_16_9", "9:16": "portrait_16_9", "4:3": "landscape_4_3", "3:4": "portrait_4_3", "1:1": "square_hd" };

function onQueue(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        return url.origin === FAL_QUEUE_ORIGIN && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function https(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        return new URL(value).protocol === "https:" ? value : null;
    } catch {
        return null;
    }
}

function text(input: Record<string, unknown>, name: string, required: boolean, max = 4000): string | undefined {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
        if (required) throw new JobFailedError(`${name} is required.`);
        return undefined;
    }
    if (typeof value !== "string" || value.length > max) throw new JobFailedError(`${name} must be text of at most ${max} characters.`);
    return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
        }, { once: true });
    });
}

/** fal error bodies: { detail: string | [{ msg }] } */
async function errorMessage(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        if (typeof parsed.detail === "string") return parsed.detail;
        if (Array.isArray(parsed.detail)) return parsed.detail.map((d) => (d as { msg?: string }).msg ?? "").filter(Boolean).join("; ") || `fal.ai answered ${response.status}.`;
    } catch {
        // not JSON
    }
    return `fal.ai answered ${response.status}.`;
}

export function createFalProvider(options: FalProviderOptions): Provider {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const pollMs = options.pollMs ?? POLL_MS;

    async function call(key: string, capability: ProviderCapability, method: string, url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
        let response: Response;
        try {
            response = await doFetch(url, {
                method, signal, credentials: "omit", redirect: "error",
                headers: { authorization: `Key ${key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (error) {
            if (signal.aborted) throw error;
            throw new JobFailedError("Can't reach fal.ai.");
        }
        if (response.status === 401 || response.status === 403) throw new FalKeyError(capability, "fal.ai did not accept the key. Check it in Settings → AI providers.");
        if (!response.ok) throw new JobFailedError(await errorMessage(response));
        return response.json();
    }

    async function upload(key: string, capability: ProviderCapability, value: unknown, name: string, purpose: MediaPreparePurpose, context: JobContext): Promise<string> {
        const ref = parseMediaSourceRef(value);
        if (typeof ref === "string") throw new JobFailedError(`${name}: ${ref}`);
        if (!options.prepareMedia) throw new FalKeyError(capability, FAL_PREPARE_UNAVAILABLE);
        context.report(0, "Preparing");
        const prepared = await options.prepareMedia({ kind: "media", source: ref }, purpose, context.signal);
        context.report(null, "Uploading");
        const answer = (await call(key, capability, "POST", `${FAL_STORAGE_INITIATE}?storage_type=fal-cdn-v3`, { content_type: prepared.contentType, file_name: prepared.filename || "media" }, context.signal)) as { upload_url?: unknown; file_url?: unknown };
        const target = https(answer.upload_url);
        const fileUrl = https(answer.file_url);
        if (!target || !fileUrl) throw new JobFailedError("fal.ai did not give an https upload address.");
        const bytes = prepared.data instanceof Uint8Array ? prepared.data : new Uint8Array(await prepared.data.arrayBuffer());
        let response: Response;
        try {
            // No key here: the upload URL is fal's signed storage address.
            response = await doFetch(target, {
                method: "PUT", headers: { "content-type": prepared.contentType }, body: bytes as Uint8Array<ArrayBuffer>, signal: context.signal,
                credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
            });
        } catch (error) {
            if (context.signal.aborted) throw error;
            throw new JobFailedError("Can't reach fal.ai storage for the upload.");
        }
        if (!response.ok) throw new JobFailedError(`The upload to fal.ai storage failed (HTTP ${response.status}).`);
        return fileUrl;
    }

    /** A media input: a project media under `refName` (uploaded to fal storage), or an https link (under `refName` or `urlName`). */
    async function mediaInput(key: string, capability: ProviderCapability, input: Record<string, unknown>, refName: string, urlName: string, purpose: MediaPreparePurpose, context: JobContext): Promise<string> {
        const value = input[refName];
        if (value !== null && typeof value === "object") return upload(key, capability, value, refName, purpose, context);
        const link = https(typeof value === "string" ? value : input[urlName]);
        if (!link) throw new JobFailedError(`${urlName} must be an https URL.`);
        return link;
    }

    async function request(key: string, capability: ProviderCapability, input: Record<string, unknown>, context: JobContext): Promise<{ model: string; body: Record<string, unknown> }> {
        const chosen = text(input, "model", false, 120);
        const model = chosen ?? FAL_MODELS[capability]?.[0]?.id;
        if (!model || !MODEL_ID.test(model)) throw new JobFailedError("Unknown fal.ai model.");
        const aspect = text(input, "aspectRatio", false, 10);
        switch (capability) {
            case "image.generate":
                return { model, body: { prompt: text(input, "description", true), num_images: 1, ...(aspect && IMAGE_SIZES[aspect] ? { image_size: IMAGE_SIZES[aspect] } : {}) } };
            case "video.text-to-video":
            case "video.image-to-video": {
                const seconds = typeof input.durationSeconds === "number" && input.durationSeconds > 7 ? "10" : "5";
                const prompt = text(input, "description", capability === "video.text-to-video") ?? "";
                const image = capability === "video.image-to-video" ? await mediaInput(key, capability, input, "image", "image", FAL_MEDIA_PURPOSES.image, context) : null;
                return {
                    model,
                    body: {
                        prompt, duration: seconds,
                        ...(aspect && ["16:9", "9:16", "1:1"].includes(aspect) ? { aspect_ratio: aspect } : {}),
                        ...(image ? { image_url: image } : {}),
                    },
                };
            }
            case "audio.isolate-voice":
                return { model, body: { audio_url: await mediaInput(key, capability, input, "source", "audioUrl", FAL_MEDIA_PURPOSES.audio, context) } };
            case "video.upscale": {
                const resolution = input.resolution ?? "1080p";
                if (resolution !== "1080p" && resolution !== "2k" && resolution !== "4k") throw new JobFailedError("resolution must be one of 1080p, 2k, 4k.");
                return { model, body: { video_url: await mediaInput(key, capability, input, "source", "videoUrl", FAL_MEDIA_PURPOSES.video, context), target_resolution: resolution } };
            }
            default:
                throw new FalKeyError(capability, `fal.ai does not offer ${capability} in OpenNan Studio.`);
        }
    }

    function mediaOf(capability: ProviderCapability, result: Record<string, unknown>): GeneratedMedia[] {
        if (capability === "image.generate") {
            const images = Array.isArray(result.images) ? (result.images as Array<Record<string, unknown>>) : [];
            return images.flatMap((image) => {
                const url = https(image.url);
                return url ? [{ kind: "image" as const, url, ...(typeof image.content_type === "string" ? { mimeType: image.content_type } : {}) }] : [];
            });
        }
        const kind = capability === "audio.isolate-voice" ? "audio" : "video";
        const file = result[kind] as Record<string, unknown> | undefined;
        const url = https(file?.url);
        return url ? [{ kind, url, ...(typeof file?.content_type === "string" ? { mimeType: file.content_type } : {}) }] : [];
    }

    async function run(capability: ProviderCapability, input: Record<string, unknown>, context: JobContext): Promise<CapabilityOutput> {
        const key = (await options.getKey())?.trim();
        if (!key) throw new FalKeyError(capability, FAL_KEY_MISSING);
        const { model, body } = await request(key, capability, input, context);
        const queued = (await call(key, capability, "POST", `${FAL_QUEUE_ORIGIN}/${model}`, body, context.signal)) as QueueAnswer;
        const statusUrl = onQueue(queued.status_url);
        const responseUrl = onQueue(queued.response_url);
        const cancelUrl = onQueue(queued.cancel_url);
        if (!statusUrl || !responseUrl) throw new JobFailedError("fal.ai did not queue the request.");
        const onAbort = () => {
            if (cancelUrl) void doFetch(cancelUrl, { method: "PUT", headers: { authorization: `Key ${key}` }, credentials: "omit", redirect: "error" }).catch(() => undefined);
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        try {
            for (;;) {
                const status = (await call(key, capability, "GET", statusUrl, undefined, context.signal)) as { status?: string; queue_position?: number };
                if (status.status === "COMPLETED") break;
                if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new JobFailedError(`fal.ai reported ${String(status.status)}.`);
                context.report(null, status.status === "IN_QUEUE" ? (typeof status.queue_position === "number" ? `In queue (${status.queue_position} ahead)` : "In queue") : "Generating");
                await sleep(pollMs, context.signal);
            }
            const result = (await call(key, capability, "GET", responseUrl, undefined, context.signal)) as Record<string, unknown>;
            const media = mediaOf(capability, result);
            if (media.length === 0) throw new JobFailedError("fal.ai returned no media.");
            return { media };
        } finally {
            context.signal.removeEventListener("abort", onAbort);
        }
    }

    return {
        info: { id: FAL_PROVIDER_ID, name: "fal.ai", capabilities: [...FAL_CAPABILITIES] },
        models: async (capability) => [...(FAL_MODELS[capability] ?? [])],
        // fal bills the user's own account.
        price: async () => ({ kind: "billed-elsewhere", by: "fal.ai" }),
        run: ({ capability, input }) => createJob((context) => run(capability, input, context)),
    };
}

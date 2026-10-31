// The OpenNan provider (spec §5.5): id "opennan", every open capability it can run plus every opennan.* capability
// (spec §2.1). A thin client: inputs go to the opennan.com public API, results come back as media; no pipeline
// logic runs here. Image, video, and music are tasks (POST …/generations, then GET /v1/tasks/{id}?wait=50);
// speech and sound effects answer with the audio itself. Phase 11 adds the media tools and cloud captions
// (tools.ts: media prepared by the host, uploaded with uploads.ts), prices (prices.ts), and refusable cancel.
import {
    CapabilityUnavailableError, JobFailedError, OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, createJob, isLocalOnlyCapability, isOpenNanCapability,
    type CapabilityOutput, type GeneratedMedia, type GeneratedMediaKind, type JobContext, type MediaPreparer, type PreparedMedia, type Provider, type ProviderCapability, type ProviderModel,
    type TranscribeRequest, type Transcript,
} from "@opennan/provider-sdk";
import { InsufficientCreditsError, OpenNanApiError, OpenNanSignInRequiredError, notChargedError, openNanErrorMessage } from "./errors";
import { allowedLink, defined, flag, number, oneOf, text, type Input } from "./inputs";
import { createOpenNanCatalog, priceRun } from "./prices";
import { createQuoteClient } from "./quotes";
import type { OpenNanSession } from "./session";
import { MIN_TASK_POLL_MS, runTask, costOf, type TaskBody } from "./tasks";
import { runTextGenerate, runVideoDownload } from "./text";
import { longerThanPriced, parseReferenceVideos, preparedReferenceProblem, referenceLengthProblem, referencePurpose, type ReferenceVideoInput } from "./references";
import { MEDIA_TOOL_CAPABILITIES, imageInput, prepare, runMediaTool, runTranscription, upload, type ToolContext } from "./tools";
import type { UploadCache } from "./uploads";

export { TASK_WAIT_SECONDS, MIN_TASK_POLL_MS, TASK_DEADLINE_MS } from "./tasks";

/**
 * What the OpenNan provider declares: every open capability but export (local) and the local-only ones, plus every
 * opennan.* capability. audio.transcribe is cloud captions; an on-device provider still wins its default route.
 */
export const OPENNAN_PROVIDER_CAPABILITIES: ProviderCapability[] = [
    ...OPEN_CAPABILITIES.filter((c) => c !== "render.export" && !isLocalOnlyCapability(c)),
    ...OPENNAN_CAPABILITIES,
];

/** Reference images an image call takes besides `image` (the server takes 10 in all), and a video call takes. */
export const MAX_IMAGE_REFERENCES = 9;
export const MAX_VIDEO_REFERENCES = 9;

/** A list input of images (project images or https links), uploaded in order; absent is none. */
async function imageList(ctx: ToolContext, capability: ProviderCapability, input: Input, name: string, max: number): Promise<string[]> {
    const raw = input[name];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > max) throw new JobFailedError(`${name} must list at most ${max} images.`);
    const urls: string[] = [];
    for (const value of raw) urls.push((await imageInput(ctx, capability, { image: value }, "image", true))!);
    return urls;
}

/**
 * The reference videos of a call, checked against the model's limits, prepared (a project range becomes an MP4 of the
 * model's size and frame rate) and uploaded as temporary inputs; nothing is uploaded when a limit is broken.
 */
async function referenceVideoUrls(ctx: ToolContext, capability: ProviderCapability, model: string, input: Input, videos: ReferenceVideoInput[]): Promise<{ urls: string[]; mode: string }> {
    let listed: ProviderModel[];
    try {
        listed = await ctx.catalog.models(capability);
    } catch {
        throw new JobFailedError(`The limits of ${model}'s reference videos could not be read: nothing was sent. Try again.`, { code: "price_unknown" });
    }
    const limits = listed.find((m) => m.id === model)?.referenceVideos;
    if (!limits) throw new JobFailedError(`${model} does not take reference videos. Pick a model that does (seedance-2-5), or animate from the keyframe.`, { code: "invalid_request" });
    const mode = oneOf(input, "referenceMode", limits.modes, (limits.modes.includes("reference") ? "reference" : limits.modes[0]) as string);
    const declared = referenceLengthProblem(limits, videos.map((v) => v.seconds), mode);
    if (declared) throw new JobFailedError(`${declared} Nothing was sent.`, { code: "invalid_request" });
    const purpose = referencePurpose(limits);
    const prepared: Array<{ url?: string; media?: PreparedMedia }> = [];
    for (const video of videos) {
        if (video.url) prepared.push({ url: video.url });
        else prepared.push({ media: await prepare(ctx, capability, { kind: "media", source: video.source! }, purpose) });
    }
    // The files as made: their lengths, size and picture, before any upload.
    const measured = prepared.map((p, i) => p.media?.durationSeconds ?? videos[i]!.seconds);
    const lengths = referenceLengthProblem(limits, measured, mode);
    if (lengths) throw new JobFailedError(`${lengths} Nothing was sent.`, { code: "invalid_request" });
    for (const p of prepared) {
        const problem = p.media ? preparedReferenceProblem(limits, p.media) : null;
        if (problem) throw new JobFailedError(`${problem} Nothing was sent.`, { code: "invalid_request" });
    }
    const sum = (list: Array<number | undefined>) => (list.every((n) => n !== undefined) ? list.reduce<number>((a, n) => a + n!, 0) : undefined);
    if (longerThanPriced(limits, sum(videos.map((v) => v.seconds)), sum(measured))) {
        throw new JobFailedError("The reference clip came out longer than the length it was priced at: nothing was sent. Price it again and run.", { code: "price_changed" });
    }
    const urls: string[] = [];
    for (const p of prepared) urls.push(p.url ?? (await upload(ctx, p.media!)));
    return { urls, mode };
}

export const INSUFFICIENT_CREDITS_MESSAGE = "Not enough credits. Buy credits on opennan.com to continue.";

/**
 * A capability the provider declares but OpenNan runs only on a project stored on its server (the story, storyboard,
 * copy-video and smart-scene pipelines). Studio projects stay on the device, so these are refused.
 */
export class OpenNanProjectPipelineError extends CapabilityUnavailableError {
    constructor(capability: ProviderCapability) {
        super(capability);
        this.name = "OpenNanProjectPipelineError";
        this.message = `${capability} runs only on projects stored on OpenNan, and OpenNan Studio keeps projects on this device.`;
    }
}

const KINDS = new Set(["image", "video", "audio"]);

function mediaOf(task: TaskBody, fallback: GeneratedMediaKind, loopbackApi: boolean): GeneratedMedia[] {
    if (!Array.isArray(task.outputs)) return [];
    const media: GeneratedMedia[] = [];
    for (const output of task.outputs as Array<Record<string, unknown>>) {
        if (typeof output?.url !== "string" || !allowedLink(output.url, loopbackApi)) continue;
        const kind = typeof output.type === "string" && KINDS.has(output.type) ? (output.type as GeneratedMediaKind) : fallback;
        media.push({ kind, url: output.url });
    }
    return media;
}

export interface OpenNanProviderOptions {
    name?: string;
    /**
     * Makes the file a media tool needs from a project media range (web: in the page; desktop: in main). Without
     * it, media tools take https links only and a project media input fails with guidance.
     */
    prepareMedia?: MediaPreparer;
    /** Milliseconds between task polls (tests); default MIN_TASK_POLL_MS. */
    pollIntervalMs?: number;
    /**
     * Hosts an upload's presigned PUT may go to besides the API's own origin (default DEFAULT_UPLOAD_HOSTS: R2). A
     * self-hosted server whose storage lives elsewhere widens it here; private and loopback addresses never pass.
     */
    uploadHosts?: readonly string[];
}

export function createOpenNanProvider(session: OpenNanSession, options: OpenNanProviderOptions = {}): Provider {
    const api = session.api;
    const loopbackApi = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(api.baseUrl);
    const catalog = createOpenNanCatalog(api);
    const quotes = createQuoteClient(api);
    // One upload cache per task (job): a tool input is a temporary upload the server deletes after its task, so the
    // next task uploads again; within one task the same file is uploaded once.
    const uploadCaches = new WeakMap<JobContext, UploadCache>();
    const cacheFor = (job: JobContext): UploadCache => {
        let cache = uploadCaches.get(job);
        if (!cache) {
            cache = new Map();
            uploadCaches.set(job, cache);
        }
        return cache;
    };
    const pollIntervalMs = options.pollIntervalMs ?? MIN_TASK_POLL_MS;

    async function models(capability: ProviderCapability): Promise<ProviderModel[]> {
        try {
            return await catalog.models(capability);
        } catch {
            return [];
        }
    }

    /** A text call's model: the one asked for, else the first listed (the first that sees images when it sends some). */
    async function textModelFor(input: Input): Promise<string> {
        const chosen = text(input, "model", false, 100);
        if (chosen) return chosen;
        const list = await models("text.generate");
        const sendsImages = Array.isArray(input.images) && input.images.length > 0;
        const first = sendsImages ? list.find((m) => m.vision) : list[0];
        if (!first) throw new JobFailedError(sendsImages ? "OpenNan lists no text model that reads images right now." : "OpenNan lists no text model right now.");
        return first.id;
    }

    async function modelFor(capability: ProviderCapability, input: Input): Promise<string> {
        const chosen = text(input, "model", false, 100);
        if (chosen) return chosen;
        const first = (await models(capability))[0];
        if (!first) throw new JobFailedError(`OpenNan lists no model for ${capability} right now.`);
        return first.id;
    }

    const toolContext = (key: string, job: JobContext): ToolContext => ({
        api, key, job, catalog, quotes, cache: cacheFor(job), loopbackApi, pollIntervalMs, ...(options.prepareMedia ? { prepareMedia: options.prepareMedia } : {}),
        ...(options.uploadHosts ? { uploadHosts: options.uploadHosts } : {}),
    });

    async function generation(path: string, body: Record<string, unknown>, key: string, context: JobContext, fallback: GeneratedMediaKind): Promise<CapabilityOutput> {
        const task = await runTask(api, key, context, path, body, { pollIntervalMs });
        const output: CapabilityOutput = { media: mediaOf(task, fallback, loopbackApi) };
        const cost = costOf(task);
        if (cost !== undefined) output.costUsd = cost;
        return output;
    }

    /** A call that answers with the audio itself: an HTTP refusal of it charged nothing. */
    async function bytes(path: string, body: Record<string, unknown>, key: string, context: JobContext) {
        try {
            return await api.requestBytes("POST", path, { apiKey: key, body, signal: context.signal });
        } catch (error) {
            if (error instanceof OpenNanApiError && error.status > 0 && !(error.status >= 500 && !error.fromServer)) throw notChargedError(error);
            throw error;
        }
    }

    async function generate(capability: ProviderCapability, input: Input, key: string, context: JobContext): Promise<CapabilityOutput> {
        if (MEDIA_TOOL_CAPABILITIES.includes(capability)) return runMediaTool(toolContext(key, context), capability, input);
        switch (capability) {
            case "image.generate":
            case "image.edit": {
                const prompt = text(input, "description", true)!;
                const aspect = text(input, "aspectRatio", false, 10);
                const tools = toolContext(key, context);
                const image = await imageInput(tools, capability, input, "image", capability === "image.edit");
                // Story film: more reference images after the first (cast sheets, the previous keyframe), in order.
                const images = await imageList(tools, capability, input, "images", MAX_IMAGE_REFERENCES);
                const model = await modelFor(capability, input);
                return generation("/v1/images/generations", defined({
                    model, prompt, image, images: images.length > 0 ? images : undefined, aspect_ratio: aspect,
                    size: text(input, "size", false, 8), quality: text(input, "quality", false, 16),
                }), key, context, "image");
            }
            case "video.text-to-video":
            case "video.image-to-video": {
                const tools = toolContext(key, context);
                // Reference videos (a remake): their motion comes from the clips, so there is no first frame to send.
                const videos = parseReferenceVideos(input, loopbackApi);
                const remake = videos.length > 0;
                if (remake && (input.image !== undefined || input.endImage !== undefined)) throw new JobFailedError("Reference videos are sent without image or endImage: send the pictures as referenceImages.");
                const i2v = capability === "video.image-to-video" && !remake;
                const prompt = text(input, "description", !i2v) ?? "";
                const duration = number(input, "durationSeconds", 1, 60);
                const aspect = text(input, "aspectRatio", false, 10);
                const image = await imageInput(tools, capability, input, "image", i2v);
                const endImage = await imageInput(tools, capability, input, "endImage", false);
                const model = await modelFor(capability, input);
                const reference = remake ? await referenceVideoUrls(tools, capability, model, input, videos) : null;
                const references = await imageList(tools, capability, input, "referenceImages", MAX_VIDEO_REFERENCES);
                return generation("/v1/videos/generations", defined({
                    model, prompt, image, end_image: endImage, reference_images: references.length > 0 ? references : undefined,
                    reference_videos: reference?.urls, reference_mode: reference?.mode, duration, aspect_ratio: aspect,
                    quality: text(input, "quality", false, 16), generate_audio: flag(input, "generateAudio"),
                }), key, context, "video");
            }
            case "text.generate":
                return runTextGenerate(toolContext(key, context), input, await textModelFor(input));
            case "web.fetch":
                return runVideoDownload(toolContext(key, context), input);
            case "audio.music": {
                const body = defined({
                    model: text(input, "model", false, 100), prompt: text(input, "description", true, 1000), lyrics: text(input, "lyrics", false),
                    duration: number(input, "durationSeconds", 10, 240), instrumental: flag(input, "instrumental"),
                });
                return generation("/v1/music/generations", body, key, context, "audio");
            }
            case "audio.tts": {
                const body = defined({
                    model: text(input, "model", false, 100), input: text(input, "text", true), voice: text(input, "voice", false, 100),
                    response_format: "mp3", speed: number(input, "speed", 0.25, 4), language: text(input, "language", false, 16),
                });
                context.report(null, "Speaking");
                const audio = await bytes("/v1/audio/speech", body, key, context);
                return { media: [{ kind: "audio", bytes: audio.bytes, mimeType: audio.mimeType, name: "speech.mp3" }] };
            }
            case "audio.sfx": {
                const body = defined({ text: text(input, "description", true), duration_seconds: number(input, "durationSeconds", 0.5, 22), response_format: "mp3" });
                context.report(null, "Generating");
                const audio = await bytes("/v1/audio/sound-effects", body, key, context);
                return { media: [{ kind: "audio", bytes: audio.bytes, mimeType: audio.mimeType, name: "sound-effect.mp3" }] };
            }
            default:
                throw new OpenNanProjectPipelineError(capability);
        }
    }

    /** Runs one call signed in, with the account's 402 / 401 handling. */
    function signedIn<T>(capability: ProviderCapability, work: (key: string, context: JobContext) => Promise<T>) {
        return createJob<T>(async (context) => {
            const key = session.apiKey();
            if (!key) {
                session.notify({ kind: "sign-in-needed", feature: capability });
                throw new OpenNanSignInRequiredError(capability);
            }
            try {
                return await work(key, context);
            } catch (error) {
                if (error instanceof InsufficientCreditsError) {
                    session.notify({ kind: "insufficient-credits", billingUrl: session.billingUrl() });
                    throw new JobFailedError(INSUFFICIENT_CREDITS_MESSAGE, { cause: error, code: "insufficient_balance" });
                }
                if (error instanceof OpenNanApiError && error.status === 401) {
                    session.reportUnauthorized();
                    throw new OpenNanSignInRequiredError(capability);
                }
                // Studio's words for the code (never raw server text that could carry internals).
                if (error instanceof OpenNanApiError) throw new JobFailedError(openNanErrorMessage(error), { cause: error, code: error.code });
                throw error;
            } finally {
                if (!context.signal.aborted && !isOpenNanCapability(capability)) session.refreshSoon();
            }
        });
    }

    return {
        info: { id: "opennan", name: options.name ?? "OpenNan", capabilities: [...OPENNAN_PROVIDER_CAPABILITIES] },
        models,
        price: (request) => priceRun(catalog, request, quotes),
        voices: () => catalog.voices(),
        run({ capability, input }) {
            return signedIn<CapabilityOutput>(capability, (key, context) => generate(capability, input, key, context));
        },
        audio: {
            transcribe(request: TranscribeRequest) {
                return signedIn<Transcript>("audio.transcribe", (key, context) => runTranscription(toolContext(key, context), request));
            },
            models: () => models("audio.transcribe"),
        },
    };
}

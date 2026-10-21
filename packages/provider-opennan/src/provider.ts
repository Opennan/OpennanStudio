// The OpenNan provider (spec §5.5): id "opennan", every open capability it can run plus every opennan.* capability
// (spec §2.1). A thin client: inputs go to the opennan.com public API, results come back as media; no pipeline
// logic runs here. Image, video, and music are tasks (POST …/generations, then GET /v1/tasks/{id}?wait=50);
// speech and sound effects answer with the audio itself. Phase 11 adds the media tools and cloud captions
// (tools.ts: media prepared by the host, uploaded with uploads.ts), prices (prices.ts), and refusable cancel.
import {
    CapabilityUnavailableError, JobFailedError, OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, createJob, isLocalOnlyCapability, isOpenNanCapability,
    type CapabilityOutput, type GeneratedMedia, type GeneratedMediaKind, type JobContext, type MediaPreparer, type Provider, type ProviderCapability, type ProviderModel,
    type TranscribeRequest, type Transcript,
} from "@opennan/provider-sdk";
import { InsufficientCreditsError, OpenNanApiError, OpenNanSignInRequiredError, notChargedError, openNanErrorMessage } from "./errors";
import { allowedLink, defined, flag, number, text, type Input } from "./inputs";
import { createOpenNanCatalog, priceRun } from "./prices";
import { createQuoteClient } from "./quotes";
import type { OpenNanSession } from "./session";
import { MIN_TASK_POLL_MS, runTask, costOf, type TaskBody } from "./tasks";
import { MEDIA_TOOL_CAPABILITIES, imageInput, runMediaTool, runTranscription, type ToolContext } from "./tools";
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

export const INSUFFICIENT_CREDITS_MESSAGE = "Not enough credits. Buy credits on opennan.com to continue.";

/** A capability the provider declares but runs only on OpenNan cloud projects (phase 9). */
export class OpenNanCloudProjectError extends CapabilityUnavailableError {
    constructor(capability: ProviderCapability) {
        super(capability);
        this.name = "OpenNanCloudProjectError";
        this.message = `${capability} runs on OpenNan cloud projects, which come to OpenNan Studio in a later version.`;
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
                const image = await imageInput(toolContext(key, context), capability, input, "image", capability === "image.edit");
                const model = await modelFor(capability, input);
                return generation("/v1/images/generations", defined({ model, prompt, image, aspect_ratio: aspect }), key, context, "image");
            }
            case "video.text-to-video":
            case "video.image-to-video": {
                const i2v = capability === "video.image-to-video";
                const prompt = text(input, "description", !i2v) ?? "";
                const duration = number(input, "durationSeconds", 1, 60);
                const aspect = text(input, "aspectRatio", false, 10);
                const tools = toolContext(key, context);
                const image = await imageInput(tools, capability, input, "image", i2v);
                const endImage = await imageInput(tools, capability, input, "endImage", false);
                const model = await modelFor(capability, input);
                return generation("/v1/videos/generations", defined({ model, prompt, image, end_image: endImage, duration, aspect_ratio: aspect }), key, context, "video");
            }
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
                throw new OpenNanCloudProjectError(capability);
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

// Cloud providers run in main (phase 8): their keys never leave this process. The renderer registers a proxy for
// each provider listed here and runs jobs through validated IPC; every finished job's media is downloaded here
// (https only, no credentials, size-capped) and imported into the media store, so the renderer, the editor, and
// agents only ever see opennan-local:// media. Phase 11: media tool inputs name project media (MediaSourceRef, imported
// media only); main prepares the file (prepare-media.ts) and the provider uploads it here, so upload URLs never reach
// the renderer either. Prices, voices, and cloud captions are answered here too.
import {
    CapabilityUnavailableError, JobCancelledError, JobFailedError, ProviderRegistry, downloadMedia, isCapabilityOutput, parseMediaSourceRef,
    type AudioInput, type GeneratedMedia, type Job, type JobUpdate, type MediaPreparer, type PriceAnswer, type PriceRequest, type Provider,
    type ProviderCapability, type ProviderInfo, type ProviderModel, type ProviderVoice, type Transcript, CANCEL_REFUSED_MESSAGE,
} from "@opennan/provider-sdk";
import { CANCEL_TOO_LATE_MESSAGE, INSUFFICIENT_CREDITS_MESSAGE, createOpenNanProvider, redactKeys, type OpenNanSession } from "@opennan/provider-opennan";
import { FAL_PROVIDER_ID, createFalProvider } from "@opennan/provider-fal";
import type { ImportedOutputMedia, ProviderErrorKind, ProviderJobEvent } from "../../shared/bridge";
import { EVENTS } from "../../shared/channels";
import { localMediaId } from "../../shared/media-policy";
import type { MediaStore } from "../store/media-store";


export const MAX_PROVIDER_JOBS = 4;
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
/** Input fields that carry a MediaSourceRef (provider-opennan and provider-fal media tools). */
export const MEDIA_REF_FIELDS = ["source", "videoSource", "audioSource", "image", "endImage"] as const;
export const MEDIA_REF_REFUSED = "AI tools take media imported into this project only.";

export type { ImportedOutputMedia, ProviderErrorKind, ProviderJobEvent } from "../../shared/bridge";
export interface ProviderHostOptions {
    session: OpenNanSession;
    mediaStore: Pick<MediaStore, "importBytes">;
    send(channel: string, payload: unknown): void;
    /** More providers that run in main. */
    providers?: Provider[];
    /** The stored fal.ai key (FAL_KEY in safeStorage): fal is a provider while it exists. */
    falKey?(): string | null;
    fetch?: typeof globalThis.fetch;
    /** Makes the files media tools upload (main's ffmpeg over the media library). */
    prepareMedia?: MediaPreparer;
    /** Plain-http downloads from loopback (only the e2e build's fake OpenNan server). */
    allowLoopbackDownloads?: boolean;
    now?(): number;
}

export interface TranscribeRequestInput {
    providerId: string;
    audio: AudioInput;
    language?: string;
    model?: string;
    expectedMaxUsd?: number;
}

export interface ProviderHost {
    registry: ProviderRegistry;
    /** Re-reads stored keys (after the renderer saved or removed one) and adds or drops those providers. */
    syncKeys(): void;
    list(): ProviderInfo[];
    models(providerId: string, capability: ProviderCapability): Promise<ProviderModel[]>;
    /** Every capability but audio.transcribe (transcribe()). Media refs must name imported media. */
    run(request: { providerId: string; capability: ProviderCapability; input: Record<string, unknown>; projectId: string }): { jobId: string };
    /** audio.transcribe on a cloud provider; the last event carries the transcript. */
    transcribe(request: TranscribeRequestInput): { jobId: string };
    /** Asks the provider to stop the job: false when it refused (its paid step started) and the job runs on. */
    /** A refused cancel says why (message): it will finish and be charged, or it had already finished. */
    cancel(jobId: string): Promise<{ cancelled: boolean; message?: string }>;
    cancelAll(): void;
    /** What a run would cost (the provider's own rule); "unknown" when it has none or cannot say. */
    price(providerId: string, request: PriceRequest): Promise<PriceAnswer>;
    voices(providerId: string): Promise<ProviderVoice[]>;
}

const EXTENSIONS: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mp4": ".m4a",
};
const FALLBACK_MIME: Record<GeneratedMedia["kind"], string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Refuses a MediaSourceRef (an object under a media field) that is not media imported into the project. */
export function checkMediaRefs(input: Record<string, unknown>): void {
    for (const field of MEDIA_REF_FIELDS) {
        const value = input[field];
        if (value === undefined || value === null || typeof value !== "object") continue;
        const ref = parseMediaSourceRef(value);
        if (typeof ref === "string" || localMediaId(ref.mediaUrl) === null) throw new Error(`${field}: ${MEDIA_REF_REFUSED}`);
    }
}

export function createProviderHost(options: ProviderHostOptions): ProviderHost {
    const registry = new ProviderRegistry();
    const prepare = options.prepareMedia ? { prepareMedia: options.prepareMedia } : {};
    registry.register(createOpenNanProvider(options.session, prepare));
    for (const provider of options.providers ?? []) registry.register(provider);
    const syncKeys = () => {
        const key = options.falKey?.() ?? null;
        if (key && !registry.get(FAL_PROVIDER_ID)) registry.register(createFalProvider({ getKey: () => options.falKey?.() ?? null, ...(options.fetch ? { fetch: options.fetch } : {}), ...prepare }));
        else if (!key && registry.get(FAL_PROVIDER_ID)) registry.unregister(FAL_PROVIDER_ID);
    };
    syncKeys();
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const now = options.now ?? Date.now;
    const jobs = new Map<string, Job<unknown>>();
    /** Ids of jobs that finished here (the last few hundred), so a late cancel can say it came too late. */
    const finished = new Set<string>();
    const rememberFinished = (jobId: string) => {
        finished.add(jobId);
        if (finished.size > 500) finished.delete(finished.values().next().value as string);
    };
    let serial = 0;

    const download = (url: string) => downloadMedia(url, { fetch: doFetch, allowLoopback: options.allowLoopbackDownloads, maxBytes: MAX_DOWNLOAD_BYTES });

    async function importMedia(media: GeneratedMedia, projectId: string): Promise<ImportedOutputMedia> {
        let bytes: Uint8Array;
        let mimeType = media.mimeType ?? "";
        if (media.bytes) bytes = media.bytes;
        else if (media.url) {
            const downloaded = await download(media.url);
            bytes = downloaded.bytes;
            mimeType = downloaded.mimeType || mimeType;
        } else throw new Error("The provider returned media without a file.");
        if (!EXTENSIONS[mimeType]) mimeType = FALLBACK_MIME[media.kind];
        const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
        const stored = await options.mediaStore.importBytes({ projectId, name: `${media.kind}-${stamp}${EXTENSIONS[mimeType]}`, mimeType, kind: media.kind, bytes });
        return {
            kind: media.kind, url: stored.url, name: stored.name, mimeType: stored.mimeType, sizeBytes: stored.size,
            ...(stored.durationSeconds ? { durationSeconds: stored.durationSeconds } : {}),
            ...(stored.width && stored.height ? { width: stored.width, height: stored.height } : {}),
        };
    }

    // Provider and server text is redacted on the way out, so no key-shaped string reaches the renderer.
    const emit = (event: ProviderJobEvent) => options.send(EVENTS.providersJob, {
        ...event,
        ...(event.error !== undefined ? { error: redactKeys(event.error) } : {}),
        ...(event.message !== undefined ? { message: redactKeys(event.message) } : {}),
    });

    /** Forwards a job's updates (progress, and cancellable: false once a cancel was refused) as events. */
    function follow(jobId: string, job: Job<unknown>) {
        return job.subscribe?.((update: JobUpdate) => {
            if (update.status !== "queued" && update.status !== "running") return;
            const event: ProviderJobEvent = { jobId, status: update.status };
            if (update.progress !== undefined) event.progress = update.progress;
            if (update.message !== undefined) event.message = update.message;
            if (update.cancellable !== undefined) event.cancellable = update.cancellable;
            emit(event);
        });
    }

    function failed(jobId: string, error: unknown) {
        if (error instanceof JobCancelledError) {
            emit({ jobId, status: "cancelled" });
            return;
        }
        const message = errorText(error);
        const errorKind: ProviderErrorKind = error instanceof CapabilityUnavailableError ? "unavailable" : message === INSUFFICIENT_CREDITS_MESSAGE ? "insufficient-credits" : "failed";
        const event: ProviderJobEvent = { jobId, status: "failed", error: message, errorKind };
        if (error instanceof JobFailedError) {
            if (error.code !== undefined) event.code = error.code;
            if (error.refunded !== undefined) event.refunded = error.refunded;
        }
        emit(event);
    }

    function track<T>(job: Job<T>, finish: (jobId: string, value: T) => Promise<void>): { jobId: string } {
        const jobId = `job-main${++serial}`;
        jobs.set(jobId, job as Job<unknown>);
        const stop = follow(jobId, job as Job<unknown>);
        void job.result().then((value) => finish(jobId, value)).catch((error: unknown) => failed(jobId, error)).finally(() => {
            stop?.();
            jobs.delete(jobId);
            rememberFinished(jobId);
        });
        return { jobId };
    }

    const room = () => {
        if (jobs.size >= MAX_PROVIDER_JOBS) throw new Error(`At most ${MAX_PROVIDER_JOBS} AI jobs run at once.`);
    };

    return {
        registry,
        syncKeys,
        list: () => registry.providers().map((p) => ({ id: p.info.id, name: p.info.name, capabilities: [...p.info.capabilities] })),
        async models(providerId, capability) {
            const provider = registry.get(providerId);
            if (!provider || !provider.info.capabilities.includes(capability)) return [];
            if (capability === "audio.transcribe") return (await provider.audio?.models?.(capability).catch(() => [])) ?? [];
            return (await provider.models?.(capability).catch(() => [])) ?? [];
        },
        run({ providerId, capability, input, projectId }) {
            const provider = registry.get(providerId);
            if (capability === "audio.transcribe" || !provider || !provider.info.capabilities.includes(capability) || !provider.run) throw new Error(`Provider "${providerId}" does not run ${capability} here.`);
            checkMediaRefs(input);
            room();
            return track(provider.run({ capability, input }), async (jobId, value) => {
                if (!isCapabilityOutput(value)) throw new Error(`Provider "${providerId}" returned no media list.`);
                const media: ImportedOutputMedia[] = [];
                for (const item of value.media) media.push(await importMedia(item, projectId));
                const output: ProviderJobEvent["output"] = { media };
                if (value.result !== undefined) output.result = value.result;
                if (value.costUsd !== undefined) output.costUsd = value.costUsd;
                if (value.sourceSize !== undefined) output.sourceSize = { width: value.sourceSize.width, height: value.sourceSize.height };
                emit({ jobId, status: "succeeded", progress: 1, output });
            });
        },
        transcribe({ providerId, audio, language, model, expectedMaxUsd }) {
            const provider = registry.get(providerId);
            const transcribe = provider?.audio?.transcribe;
            if (!provider || !provider.info.capabilities.includes("audio.transcribe") || !transcribe) throw new Error(`Provider "${providerId}" does not run audio.transcribe here.`);
            if (audio.kind === "media" && localMediaId(audio.url) === null) throw new Error(`audio: ${MEDIA_REF_REFUSED}`);
            room();
            const job = transcribe.call(provider.audio, {
                audio,
                ...(language === undefined ? {} : { language }),
                ...(model === undefined ? {} : { model }),
                ...(expectedMaxUsd === undefined ? {} : { expectedMaxUsd }),
            });
            return track<Transcript>(job, async (jobId, transcript) => {
                emit({ jobId, status: "succeeded", progress: 1, transcript });
            });
        },
        async cancel(jobId) {
            const job = jobs.get(jobId);
            // A job main ran and has forgotten finished: too late. An id main never ran: nothing to say.
            if (!job) return finished.has(jobId) ? { cancelled: false, message: CANCEL_TOO_LATE_MESSAGE } : { cancelled: false };
            // The refusal's own words: what the job publishes while cancel() decides (not an earlier or later stage text).
            let refusal: string | undefined;
            let armed = false;
            const stop = job.subscribe?.((update) => {
                if (armed && update.cancellable === false && update.message) refusal = update.message;
            });
            armed = true;
            try {
                await job.cancel();
            } finally {
                stop?.();
            }
            const status = await job.status();
            if (status === "cancelled") return { cancelled: true };
            // Too late: the job's final state reaches the renderer as its own event.
            if (status === "succeeded" || status === "failed") return { cancelled: false, message: CANCEL_TOO_LATE_MESSAGE };
            return { cancelled: false, message: refusal ?? CANCEL_REFUSED_MESSAGE };
        },
        cancelAll() {
            for (const job of jobs.values()) void job.cancel();
        },
        async price(providerId, request) {
            const provider = registry.get(providerId);
            if (!provider?.price || !provider.info.capabilities.includes(request.capability)) return { kind: "unknown" };
            try {
                return await provider.price(request);
            } catch (error) {
                return { kind: "unknown", reason: redactKeys(errorText(error)).slice(0, 300) };
            }
        },
        async voices(providerId) {
            return (await registry.get(providerId)?.voices?.().catch(() => [])) ?? [];
        },
    };
}

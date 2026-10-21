// The renderer's ProviderRegistry (spec §5.4): the on-device provider whose jobs run in main (provider-local,
// whisper.cpp, over the timeline or a clip's range) behind the validated AI channels. ai.run, the Auto captions dialog, and MCP tools (whose editor
// calls run on this renderer's controller) all reach it through the registry.
import {
    CapabilityUnavailableError, JobCancelledError, JobFailedError, ProviderRegistry, createJob, parseMediaSourceRef,
    type AudioInput, type CapabilityOutput, type MediaSourceRef, type Provider, type ProviderCapability, type ProviderInfo, type TranscribeRequest, type Transcript,
} from "@opennan/provider-sdk";
import { OPENNAN_PROVIDER_CAPABILITIES } from "@opennan/provider-opennan";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import type { ProviderPlatform, ProviderRouting } from "@opennan/web/studio";
import type { AiJobEvent, DesktopBridge, ProviderJobEvent } from "../shared/bridge";

export const LOCAL_PROVIDER = { id: "local", name: "On this device" } as const;
/** Stabilize (ffmpeg deshake in main): a separate provider so it is listed whenever ffmpeg is there, whisper or not. */
export const LOCAL_MEDIA_PROVIDER = { id: "local-media", name: "On this device" } as const;

export interface DesktopProviders {
    registry: ProviderRegistry;
    /** Re-reads main's cloud providers (after a provider key was saved or removed). */
    refreshCloud(): Promise<void>;
    /** Resolves once main has said whether on-device transcription is available. */
    ready: Promise<void>;
    /** Why audio.transcribe is not registered (null while available or not yet known). */
    unavailableReason(): string | null;
}

/** A media AudioInput as the MediaSourceRef main takes. */
function sourceOf(audio: Extract<AudioInput, { kind: "media" }>): MediaSourceRef {
    return {
        mediaUrl: audio.url,
        ...(audio.startSeconds === undefined ? {} : { startSeconds: audio.startSeconds }),
        ...(audio.endSeconds === undefined ? {} : { endSeconds: audio.endSeconds }),
    };
}

/** The on-device provider as a proxy: each transcribe() is one job in main, mirrored as a local Job. */
export function createRemoteLocalProvider(bridge: Pick<DesktopBridge, "ai">): Provider {
    function transcribe(request: TranscribeRequest) {
        return createJob<Transcript>(({ signal, report }) => new Promise<Transcript>((resolve, reject) => {
            let jobId: string | null = null;
            // Events can arrive before transcribe() answers with the id: keep them until it does.
            const early: AiJobEvent[] = [];
            const handle = (event: AiJobEvent) => {
                if (event.status === "running" || event.status === "queued") {
                    report(event.progress ?? null, event.message);
                    return;
                }
                stop();
                if (event.status === "succeeded" && event.transcript) resolve(event.transcript);
                else if (event.status === "cancelled") reject(new JobCancelledError());
                else reject(new JobFailedError(event.error ?? "Transcription failed"));
            };
            const stop = bridge.ai.onJob((event) => {
                if (jobId === null) early.push(event);
                else if (event.jobId === jobId) handle(event);
            });
            const cancel = () => {
                if (jobId) void bridge.ai.cancel(jobId).catch(() => undefined);
            };
            signal.addEventListener("abort", cancel, { once: true });
            const audio = request.audio;
            bridge.ai.transcribe({
                ...(request.language === undefined ? {} : { language: request.language }),
                ...(request.model === undefined ? {} : { model: request.model }),
                ...(audio.kind === "timeline" ? { snapshot: audio.snapshot as ControllerSnapshot } : { source: sourceOf(audio) }),
            }).then(({ jobId: id }) => {
                jobId = id;
                if (signal.aborted) cancel();
                for (const event of early.splice(0)) if (event.jobId === id) handle(event);
            }, (error: unknown) => {
                stop();
                reject(error);
            });
        }));
    }
    return {
        info: { ...LOCAL_PROVIDER, capabilities: ["audio.transcribe"], onDevice: true },
        audio: { transcribe, models: () => bridge.ai.models() },
    };
}

/** media.stabilize as a proxy: each run is one stabilize job in main, whose result main already imported. */
export function createLocalMediaProvider(bridge: Pick<DesktopBridge, "ai">): Provider {
    return {
        info: { ...LOCAL_MEDIA_PROVIDER, capabilities: ["media.stabilize"], onDevice: true },
        run({ capability, input, projectId }) {
            return createJob<CapabilityOutput>(({ signal, report }) => new Promise<CapabilityOutput>((resolve, reject) => {
                if (capability !== "media.stabilize") {
                    reject(new JobFailedError(`${capability} does not run on this device.`));
                    return;
                }
                if (!projectId) {
                    reject(new JobFailedError("No project is open."));
                    return;
                }
                const source = parseMediaSourceRef(input.source);
                if (typeof source === "string") {
                    reject(new JobFailedError(`source: ${source}`));
                    return;
                }
                let jobId: string | null = null;
                const early: AiJobEvent[] = [];
                const handle = (event: AiJobEvent) => {
                    if (event.status === "running" || event.status === "queued") {
                        report(event.progress ?? null, event.message);
                        return;
                    }
                    stop();
                    if (event.status === "succeeded" && event.output) {
                        resolve({ media: event.output.media.map((m) => ({ ...m })), ...(event.output.sourceSize ? { sourceSize: { ...event.output.sourceSize } } : {}) });
                    }
                    else if (event.status === "cancelled") reject(new JobCancelledError());
                    else reject(new JobFailedError(event.error ?? "Stabilize failed"));
                };
                const stop = bridge.ai.onJob((event) => {
                    if (jobId === null) early.push(event);
                    else if (event.jobId === jobId) handle(event);
                });
                const cancel = () => {
                    if (jobId) void bridge.ai.cancel(jobId).catch(() => undefined);
                };
                signal.addEventListener("abort", cancel, { once: true });
                bridge.ai.stabilize({ projectId, source }).then(({ jobId: id }) => {
                    jobId = id;
                    if (signal.aborted) cancel();
                    for (const event of early.splice(0)) if (event.jobId === id) handle(event);
                }, (error: unknown) => {
                    stop();
                    reject(new JobFailedError(remoteMessage(error)));
                });
            }));
        },
    };
}

/** A guidance failure from main (sign in to OpenNan): shown as guidance, like any CapabilityUnavailableError. */
export class RemoteCapabilityError extends CapabilityUnavailableError {
    constructor(capability: ProviderCapability, message: string) {
        super(capability);
        this.name = "RemoteCapabilityError";
        this.message = message;
    }
}

export const OPENNAN_INFO: ProviderInfo = { id: "opennan", name: "OpenNan", capabilities: [...OPENNAN_PROVIDER_CAPABILITIES] };

const remoteMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * One job in main mirrored as a local Job: progress, the outcome, and cancel. A cancel asks main first (waiting for
 * main's job id when it comes before it): when the provider refuses (its paid step started), the local job keeps
 * running too and reports cancellable: false.
 */
function mirrorJob<T>(
    bridge: Pick<DesktopBridge, "providers">,
    capability: ProviderCapability,
    start: () => Promise<{ jobId: string }>,
    outcome: (event: ProviderJobEvent) => T | undefined,
) {
    return createJob<T>(({ signal, report, onCancel }) => new Promise<T>((resolve, reject) => {
        let jobId: string | null = null;
        let asked = false;
        const early: ProviderJobEvent[] = [];
        const handle = (event: ProviderJobEvent) => {
            if (event.status === "running" || event.status === "queued") {
                report(event.progress ?? null, event.message);
                return;
            }
            stop();
            const value = event.status === "succeeded" ? outcome(event) : undefined;
            if (value !== undefined) resolve(value);
            else if (event.status === "cancelled") reject(new JobCancelledError());
            else if (event.errorKind === "unavailable") reject(new RemoteCapabilityError(capability, event.error ?? "This needs a provider."));
            else {
                reject(new JobFailedError(event.error ?? "The job failed.", {
                    ...(event.code !== undefined ? { code: event.code } : {}), ...(event.refunded !== undefined ? { refunded: event.refunded } : {}),
                }));
            }
        };
        const stop = bridge.providers.onJob((event) => {
            if (jobId === null) early.push(event);
            else if (event.jobId === jobId) handle(event);
        });
        // Main decides every cancel: one asked before main answers with the id waits for it. When main never
        // started the job there is nothing to stop (cancelled); otherwise main's answer stands (it may refuse: its
        // paid step started). A cancel that cannot reach main is not reported as cancelled (the job may still run).
        let named!: (id: string | null) => void;
        const idKnown = new Promise<string | null>((resolve) => {
            named = resolve;
        });
        onCancel(async () => {
            const id = await idKnown;
            if (id === null) return true;
            asked = true;
            try {
                const answer = await bridge.providers.cancel(id);
                if (answer.cancelled) return true;
                // Main's own refusal message (it will finish and be charged, or it had already finished).
                return typeof answer.message === "string" && answer.message ? { accepted: false as const, message: answer.message.slice(0, 200) } : false;
            } catch {
                return false;
            }
        });
        const cancelInMain = () => {
            if (jobId && !asked) void bridge.providers.cancel(jobId).catch(() => undefined);
        };
        signal.addEventListener("abort", cancelInMain, { once: true });
        start().then(({ jobId: id }) => {
            jobId = id;
            named(id);
            if (signal.aborted) cancelInMain();
            for (const event of early.splice(0)) if (event.jobId === id) handle(event);
        }, (error: unknown) => {
            named(null);
            stop();
            reject(new JobFailedError(remoteMessage(error)));
        });
    }));
}

/**
 * A cloud provider whose jobs run in main (provider-host.ts): its key and its uploads stay there; results come back
 * imported. Prices, voices, and cloud captions (audio.transcribe) go through main too.
 */
export function createRemoteCloudProvider(bridge: Pick<DesktopBridge, "providers">, info: ProviderInfo): Provider {
    const provider: Provider = {
        info: { ...info, capabilities: [...info.capabilities] },
        models: (capability) => bridge.providers.models(info.id, capability),
        price: (request) => bridge.providers.price(info.id, request).catch((error: unknown) => ({ kind: "unknown" as const, reason: remoteMessage(error) })),
        voices: () => bridge.providers.voices(info.id),
        run({ capability, input, projectId }) {
            if (!projectId) return createJob<CapabilityOutput>(async () => { throw new JobFailedError("No project is open."); });
            return mirrorJob<CapabilityOutput>(bridge, capability, () => bridge.providers.run({ providerId: info.id, capability, input, projectId }), (event) => (
                event.output ? { ...event.output, media: event.output.media.map((m) => ({ ...m })), ...(event.output.sourceSize ? { sourceSize: { ...event.output.sourceSize } } : {}) } : undefined
            ));
        },
    };
    if (info.capabilities.includes("audio.transcribe")) {
        provider.audio = {
            transcribe: (request: TranscribeRequest) => mirrorJob<Transcript>(bridge, "audio.transcribe", () => bridge.providers.transcribe({
                providerId: info.id, audio: request.audio,
                ...(request.language === undefined ? {} : { language: request.language }),
                ...(request.model === undefined ? {} : { model: request.model }),
                ...(request.expectedMaxUsd === undefined ? {} : { expectedMaxUsd: request.expectedMaxUsd }),
            }), (event) => event.transcript),
            models: () => bridge.providers.models(info.id, "audio.transcribe"),
        };
    }
    return provider;
}

export function createDesktopProviders(bridge: Pick<DesktopBridge, "ai" | "providers" | "app">): DesktopProviders {
    const registry = new ProviderRegistry();
    // OpenNan is always there (on by default; signed out it answers with the sign-in guidance), so register it at
    // once; main's list adds the others (fal with a stored key).
    registry.register(createRemoteCloudProvider(bridge, OPENNAN_INFO));
    let reason: string | null = null;
    const local = bridge.ai.status().then((status) => {
        if (status.available) registry.register(createRemoteLocalProvider(bridge));
        else reason = status.reason ?? "On-device transcription is not available.";
    }, (error: unknown) => {
        reason = error instanceof Error ? error.message : String(error);
    });
    // Stabilize needs only the bundled ffmpeg.
    const media = bridge.app.info().then((info) => {
        if (info.ffmpeg.available && !registry.get(LOCAL_MEDIA_PROVIDER.id)) registry.register(createLocalMediaProvider(bridge));
    }, () => undefined);
    const onDevice = new Set<string>([LOCAL_PROVIDER.id, LOCAL_MEDIA_PROVIDER.id, OPENNAN_INFO.id]);
    const refreshCloud = () => bridge.providers.list().then((infos) => {
        for (const info of infos) if (!registry.get(info.id)) registry.register(createRemoteCloudProvider(bridge, info));
        for (const provider of registry.providers()) {
            if (!onDevice.has(provider.info.id) && !infos.some((info) => info.id === provider.info.id)) registry.unregister(provider.info.id);
        }
    }, () => undefined);
    const cloud = refreshCloud();
    return { registry, refreshCloud, ready: Promise.all([local, media, cloud]).then(() => undefined), unavailableReason: () => reason };
}

/** Settings → AI providers on desktop: routing in the settings table, bring-your-own keys in safeStorage (main). */
export function createDesktopProviderSettings(bridge: Pick<DesktopBridge, "settings" | "secrets">, options: { onKeysChanged?(): Promise<void> } = {}): ProviderPlatform & { ready: Promise<void> } {
    const listeners = new Set<() => void>();
    let routing: ProviderRouting = { overrides: {}, opennanDefault: true };
    let falSet = false;
    const readKeys = () => bridge.secrets.list().then((list) => {
        falSet = list.some((s) => s.name === "FAL_KEY" && s.set);
        notify();
    }, () => undefined);
    const notify = () => {
        for (const listener of [...listeners]) listener();
    };
    const ready = Promise.all([bridge.settings.get().then((settings) => {
        routing = { overrides: { ...settings.providerRouting.overrides } as ProviderRouting["overrides"], opennanDefault: settings.providerRouting.opennanDefault };
        notify();
    }, () => undefined), readKeys()]).then(() => undefined);
    return {
        ready,
        routing: () => routing,
        async setRouting(next) {
            routing = { overrides: { ...next.overrides }, opennanDefault: next.opennanDefault };
            notify();
            await bridge.settings.update({ providerRouting: { overrides: routing.overrides as Record<string, string>, opennanDefault: routing.opennanDefault } });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        keys: () => [{ id: "fal", name: "fal.ai", set: falSet }],
        async setKey(_id, key) {
            try {
                await bridge.secrets.set("FAL_KEY", key.trim());
            } catch (error) {
                throw new Error((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
            }
            await readKeys();
            await options.onKeysChanged?.();
        },
        async removeKey() {
            await bridge.secrets.remove("FAL_KEY");
            await readKeys();
            await options.onKeysChanged?.();
        },
    };
}

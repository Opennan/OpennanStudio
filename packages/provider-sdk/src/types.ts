// Provider and sub-provider interfaces (spec §5.4). Phase 7 types audio.transcribe; the other sub-providers
// stay open until phase 8 adds their methods.
import type { ProviderCapability } from "./capabilities";
import type { CapabilityOutput } from "./capability-output";
import type { Job } from "./job";
import type { CostEstimate, OverLimit, PriceUnits } from "./prices";
import type { TranscribeRequest, Transcript } from "./transcribe-types";

export interface ProviderInfo {
    /** "opennan", "fal", "local", ... */
    id: string;
    name: string;
    capabilities: ProviderCapability[];
    /** Runs on this device (provider-local, desktop main): wins the default route of ON_DEVICE_FIRST_CAPABILITIES. */
    onDevice?: boolean;
}

/** A voice a text-to-speech provider offers (GET /v1/audio/voices). */
export interface ProviderVoice {
    id: string;
    name: string;
    language: string;
    gender?: string;
    model?: string;
}

/** What a paid action would cost, asked before it runs (phase 11). */
export interface PriceRequest {
    capability: ProviderCapability;
    /** The run's input as it would be sent (model, resolution, ...). */
    input: Record<string, unknown>;
    units: PriceUnits;
}

export type PriceAnswer =
    | { kind: "estimate"; estimate: CostEstimate }
    | { kind: "free" }
    /** The user's own account with another service pays (fal.ai with a stored key). */
    | { kind: "billed-elsewhere"; by: string }
    | { kind: "over-limit"; limit: OverLimit }
    /** The tool is not live (unavailable / soon) or has no price right now: it cannot run. */
    | { kind: "unavailable"; reason: string }
    /** No price information (offline, signed out): the run is still allowed to ask the server. */
    | { kind: "unknown"; reason?: string };

export type ProviderCredentials = Record<string, string>;

/** A model a provider can run a capability with (local providers report which are downloaded). */
export interface ProviderModel {
    id: string;
    label: string;
    /** The provider's raw price block for the model (GET /v1/models `price`), read by its own price(). */
    price?: unknown;
    /** Lengths (seconds) a video model takes. */
    durations?: number[];
    /** Qualities a video model renders ("720p", "1080p") or sizes an image model draws ("1K", "2K"), cheapest first. */
    qualities?: string[];
    /** A text model that can look at images. */
    vision?: boolean;
    sizeBytes?: number;
    installed?: boolean;
    default?: boolean;
}

export interface AudioProvider {
    transcribe?(request: TranscribeRequest): Job<Transcript>;
    models?(capability: "audio.transcribe"): Promise<ProviderModel[]>;
}

/* eslint-disable @typescript-eslint/no-empty-object-type -- filled in by phase 8 */
export interface StoryProvider {}
export interface VideoProvider {}
export interface ImageProvider {}
export interface RenderProvider {}
/* eslint-enable @typescript-eslint/no-empty-object-type */

/** One call of any capability through Provider.run (phase 8). `input` is the capability's plain-object input. */
export interface CapabilityRequest {
    capability: ProviderCapability;
    input: Record<string, unknown>;
    /** The project the result is for (hosts that store results themselves, such as desktop main, need it). */
    projectId?: string | null;
}

export interface Provider {
    info: ProviderInfo;
    /**
     * Runs a declared capability (every one besides audio.transcribe, which has its typed method). Generation
     * resolves the media it made; opennan.* tools resolve their result. Failures reject the job with an SDK error
     * (CapabilityUnavailableError for guidance, JobFailedError, JobCancelledError).
     */
    run?(request: CapabilityRequest): Job<CapabilityOutput>;
    /** Models the provider can run a capability with (the first one, or the one marked default, is the default). */
    models?(capability: ProviderCapability): Promise<ProviderModel[]>;
    /** What a run would cost (phase 11): never below what it settles at. Providers without prices omit it. */
    price?(request: PriceRequest): Promise<PriceAnswer>;
    /** Text-to-speech voices. */
    voices?(): Promise<ProviderVoice[]>;
    /** Optional: providers without credentials (provider-local) have nothing to connect. */
    connect?(credentials: ProviderCredentials): Promise<void>;
    story?: StoryProvider;
    video?: VideoProvider;
    image?: ImageProvider;
    audio?: AudioProvider;
    render?: RenderProvider;
}

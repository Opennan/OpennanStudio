// Provider capabilities (spec §5.4). The provider SDK owns these lists; @opennan/mcp-schema re-exports them
// for its tool definitions. Phase 8 confirms or renames the provisional entries.

/** Capabilities any provider may implement. */
export const OPEN_CAPABILITIES = [
    // spec §5.4
    "video.text-to-video", "video.image-to-video", "video.lipsync",
    "image.generate", "image.edit", "image.remove-background",
    "audio.tts", "audio.voice-clone", "audio.music", "audio.sfx", "audio.transcribe",
    "render.export",
    // Added in phase 5 for OpenNan tools outside the §5.4 list (spec delta); phase 11 runs
    // video.remove-background and audio.separate.
    "video.edit", "video.remove-background", "video.face-swap",
    "audio.voice-convert", "audio.separate",
    "media.analyze", "media.process", "web.fetch",
    "graphics.generate", "graphics.templates",
    // Phase 11 (AI in the editor): media tools on a clip's used range, and on-device stabilize.
    "captions.translate", "audio.isolate-voice", "video.upscale", "media.stabilize",
    // Story film: a text model answers a prompt (a story draft), optionally looking at images (a video's frames).
    "text.generate",
] as const;

/** Capabilities that only run on the device (provider-local, desktop main): never OpenNan, not listed in routing. */
export const LOCAL_ONLY_CAPABILITIES = ["media.stabilize"] as const;

/** Capabilities whose default route is an on-device provider (ProviderInfo.onDevice) when one offers it. */
export const ON_DEVICE_FIRST_CAPABILITIES = ["audio.transcribe"] as const;

/** OpenNan-exclusive capabilities (spec §2.1): only provider id "opennan" may register them. */
export const OPENNAN_CAPABILITIES = [
    "opennan.story.plan", "opennan.story.storyboard", "opennan.story.consistency",
    "opennan.story.memory", "opennan.copy-video", "opennan.video.smart-scene", "opennan.qc",
] as const;

/**
 * Provider runtime features, not routing capabilities: job status is part of every
 * Job<T> (spec §5.4) and estimates come from the provider that would run the job.
 */
export const PROVIDER_RUNTIME_CAPABILITIES = ["provider.jobs", "provider.estimate"] as const;

export type OpenCapability = (typeof OPEN_CAPABILITIES)[number];
export type OpenNanCapability = (typeof OPENNAN_CAPABILITIES)[number];
export type ProviderRuntimeCapability = (typeof PROVIDER_RUNTIME_CAPABILITIES)[number];
/** What a provider declares and the registry routes. */
export type ProviderCapability = OpenCapability | OpenNanCapability;
/** What a tool or feature can need: a routed capability or a provider runtime feature. */
export type ToolCapability = ProviderCapability | ProviderRuntimeCapability;

const PROVIDER = new Set<string>([...OPEN_CAPABILITIES, ...OPENNAN_CAPABILITIES]);
const ALL = new Set<string>([...PROVIDER, ...PROVIDER_RUNTIME_CAPABILITIES]);

export function isToolCapability(value: string): value is ToolCapability {
    return ALL.has(value);
}

export function isProviderCapability(value: string): value is ProviderCapability {
    return PROVIDER.has(value);
}

export function isOpenNanCapability(value: string): value is OpenNanCapability {
    return (OPENNAN_CAPABILITIES as readonly string[]).includes(value);
}

export function isLocalOnlyCapability(value: string): boolean {
    return (LOCAL_ONLY_CAPABILITIES as readonly string[]).includes(value);
}

export function isOnDeviceFirstCapability(value: string): boolean {
    return (ON_DEVICE_FIRST_CAPABILITIES as readonly string[]).includes(value);
}

export function isProviderRuntimeCapability(value: string): value is ProviderRuntimeCapability {
    return (PROVIDER_RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

/** The guidance a host shows when no connected provider offers the capability (spec §5.4). */
export function capabilityUnavailableMessage(feature: string, capability: ToolCapability): string {
    if (isOpenNanCapability(capability)) return `Connect OpenNan to use ${feature}.`;
    if (isProviderRuntimeCapability(capability)) return `${feature} needs a connected provider. Connect OpenNan or another provider.`;
    return `${feature} requires a provider with the ${capability} capability. Connect OpenNan or another provider that offers it.`;
}

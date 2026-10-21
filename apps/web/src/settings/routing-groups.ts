// Settings → AI providers: every capability in one group with a name people recognize, and how the saved
// routing (per-capability picks + "Use OpenNan by default") is applied to the ProviderRegistry.
import { OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, isLocalOnlyCapability, isOpenNanCapability, type OpenCapability, type ProviderCapability, type ProviderRegistry } from "@opennan/provider-sdk";
import { DEFAULT_ROUTING, type ProviderPlatform, type ProviderRouting } from "../account/account-types";

export interface RoutingGroup {
    id: string;
    title: string;
    capabilities: ProviderCapability[];
    /** opennan.* capabilities: always OpenNan (spec §2.1). */
    locked: boolean;
}

export const CAPABILITY_LABELS: Record<ProviderCapability, string> = {
    "video.text-to-video": "Video from text",
    "video.image-to-video": "Video from images",
    "video.lipsync": "Lip sync and talking portraits",
    "video.edit": "Video editing by description",
    "video.remove-background": "Remove background (video)",
    "video.face-swap": "Face swap",
    "image.generate": "Image generation",
    "image.edit": "Image editing",
    "image.remove-background": "Image background removal",
    "audio.tts": "Text to speech",
    "audio.voice-clone": "Voice cloning",
    "audio.voice-convert": "Voice conversion",
    "audio.music": "Music",
    "audio.sfx": "Sound effects",
    "audio.separate": "Split vocals and stems",
    "audio.transcribe": "Transcription and auto captions",
    "render.export": "Cloud export",
    "media.analyze": "Media analysis",
    "media.process": "Media processing",
    "web.fetch": "Web capture",
    "graphics.generate": "Motion graphics",
    "graphics.templates": "Graphics templates",
    "captions.translate": "Translate captions",
    "audio.isolate-voice": "Isolate voice",
    "video.upscale": "Upscale video",
    "media.stabilize": "Stabilize video",
    "opennan.story.plan": "Story planning",
    "opennan.story.storyboard": "Storyboards",
    "opennan.story.consistency": "Character and location consistency",
    "opennan.story.memory": "Project memory",
    "opennan.copy-video": "Copy video",
    "opennan.video.smart-scene": "Smart scene video",
    "opennan.qc": "Quality checks",
};

export const ROUTING_GROUPS: RoutingGroup[] = [
    { id: "video", title: "Video", locked: false, capabilities: ["video.text-to-video", "video.image-to-video", "video.lipsync", "video.upscale", "video.remove-background", "video.edit", "video.face-swap"] },
    { id: "image", title: "Image", locked: false, capabilities: ["image.generate", "image.edit", "image.remove-background"] },
    { id: "audio", title: "Voice & audio", locked: false, capabilities: ["audio.tts", "audio.isolate-voice", "audio.separate", "audio.voice-clone", "audio.voice-convert", "audio.music", "audio.sfx"] },
    { id: "captions", title: "Captions & transcribe", locked: false, capabilities: ["audio.transcribe", "captions.translate"] },
    { id: "tools", title: "Analysis & tools", locked: false, capabilities: ["media.analyze", "media.process", "web.fetch", "graphics.generate", "graphics.templates", "render.export"] },
    { id: "story", title: "Story & storyboard", locked: true, capabilities: [...OPENNAN_CAPABILITIES] },
];

/** Makes the registry follow the saved routing: per-capability picks and the OpenNan-default switch. */
export function applyRouting(registry: ProviderRegistry, routing: ProviderRouting): void {
    for (const capability of OPEN_CAPABILITIES) if (!isLocalOnlyCapability(capability)) registry.setRoute(capability, routing.overrides[capability] ?? null);
    registry.setOpenNanDefault(routing.opennanDefault);
}

/** Applies the platform's routing now and whenever it changes; returns the unsubscribe. */
export function connectRouting(registry: ProviderRegistry, platform: ProviderPlatform): () => void {
    applyRouting(registry, platform.routing());
    return platform.subscribe(() => applyRouting(registry, platform.routing()));
}

/** Parses saved routing, keeping only open capabilities and sane provider ids. */
export function parseRouting(value: unknown): ProviderRouting {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_ROUTING, overrides: {} };
    const raw = value as { overrides?: unknown; opennanDefault?: unknown };
    const overrides: Partial<Record<OpenCapability, string>> = {};
    if (typeof raw.overrides === "object" && raw.overrides !== null) {
        for (const [capability, provider] of Object.entries(raw.overrides as Record<string, unknown>)) {
            if ((OPEN_CAPABILITIES as readonly string[]).includes(capability) && !isOpenNanCapability(capability) && typeof provider === "string" && /^[a-z0-9_-]{1,64}$/.test(provider)) {
                overrides[capability as OpenCapability] = provider;
            }
        }
    }
    return { overrides, opennanDefault: raw.opennanDefault !== false };
}

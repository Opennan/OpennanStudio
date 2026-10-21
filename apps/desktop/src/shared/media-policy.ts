// Which media URLs the desktop app plays and accepts from agents (phase 5 hand-off "Agent-supplied media
// URLs"). Desktop serves only media imported into the project: opennan-local://media/<uuid> (what
// LocalBackend stores) and its protocol form opennan-media://blob/<uuid>. The preview also keeps the
// renderer's own blob: and data:image URLs. Everything else (http(s), file:, paths, other schemes) is refused
// for preview and refused in agent commands.
import { isUuid } from "./ids";

export const LOCAL_MEDIA_PREFIX = "opennan-local://media/";
export const MEDIA_PROTOCOL_PREFIX = "opennan-media://blob/";
export const REFUSED_MEDIA_URL = "opennan-media://refused/";

/** Fields of clips, scenes, and project patches that name media (the common ones; isMediaField covers all). */
export const MEDIA_FIELDS = ["mediaUrl", "thumbnailUrl", "videoUrl", "sourceVideoUrl", "startImageUrl", "endImageUrl", "audioUrl", "musicUrl"] as const;

/** Every model field that names media ends in "Url" (videoPosterUrl, speechAudioUrl, url, ...). */
export function isMediaField(key: string): boolean {
    return /url$/i.test(key);
}

const MAX_DEPTH = 32;

/** opennan-local://media/<uuid> or opennan-media://blob/<uuid> → the id; otherwise null. */
export function localMediaId(url: string): string | null {
    for (const prefix of [LOCAL_MEDIA_PREFIX, MEDIA_PROTOCOL_PREFIX]) {
        if (url.startsWith(prefix)) {
            const id = url.slice(prefix.length);
            return isUuid(id) ? id : null;
        }
    }
    return null;
}

/** Preview mapping: local media → protocol URL; the app's own blob: and data:image URLs as they are; anything else refused. */
export function previewMediaUrl(url: string, appOrigin: string): { url: string; allowed: boolean } {
    const id = localMediaId(url);
    if (id) return { url: `${MEDIA_PROTOCOL_PREFIX}${id}`, allowed: true };
    if (url.startsWith(`blob:${appOrigin}/`)) return { url, allowed: true };
    if (/^data:image\/(png|jpeg|webp|gif);/i.test(url)) return { url, allowed: true };
    return { url: `${REFUSED_MEDIA_URL}${encodeURIComponent(url.slice(0, 200))}`, allowed: false };
}

/** Whether an agent command may carry this media URL (null and "" mean "no media"). */
export function isAllowedCommandMediaUrl(value: unknown): boolean {
    return value === null || value === undefined || value === "" || (typeof value === "string" && localMediaId(value) !== null);
}

/** Media URLs in a command (any depth) that desktop does not serve. Fails closed: too deep is refused. */
export function disallowedMediaUrls(value: unknown, found: string[] = [], depth = 0): string[] {
    if (depth > MAX_DEPTH) {
        found.push("(nested deeper than 32 levels)");
        return found;
    }
    if (typeof value === "string") {
        // JSON kept in strings (cardConfig, keyframesJson, remotionPropsJson, shots) is scanned too.
        const trimmed = value.trim();
        if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 4 * 1024 * 1024) {
            try {
                disallowedMediaUrls(JSON.parse(trimmed), found, depth + 1);
            } catch {
                // not JSON
            }
        }
        return found;
    }
    if (value === null || typeof value !== "object") return found;
    if (Array.isArray(value)) {
        for (const item of value) disallowedMediaUrls(item, found, depth + 1);
        return found;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (isMediaField(key) && typeof item !== "object") {
            if (!isAllowedCommandMediaUrl(item)) found.push(String(item));
        } else {
            disallowedMediaUrls(item, found, depth + 1);
        }
    }
    return found;
}

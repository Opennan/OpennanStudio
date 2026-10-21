// Duration probe for imported files: the browser's own media element reads the
// container metadata, as loadAudioDuration does for URLs (packages/timeline-media/src/audio-duration.ts).
// An object URL over a disk-backed Blob streams from disk; nothing is read into memory.
// A file the browser cannot decode resolves without a duration (error or timeout); the
// media bin then marks it "May not play in this browser".
import type { ProbeMedia } from "./import-media";

const PROBE_TIMEOUT_MS = 8_000;

export const probeMediaFile: ProbeMedia = async (media, kind) => {
    if (kind === "image") return {};
    const url = URL.createObjectURL(media);
    const element = document.createElement(kind === "video" ? "video" : "audio");
    try {
        const duration = await new Promise<number | undefined>((resolve) => {
            const timer = window.setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS);
            element.preload = "metadata";
            element.muted = true;
            element.onloadedmetadata = () => {
                window.clearTimeout(timer);
                resolve(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : undefined);
            };
            element.onerror = () => {
                window.clearTimeout(timer);
                resolve(undefined);
            };
            element.src = url;
        });
        return duration ? { durationSeconds: duration } : {};
    } finally {
        element.removeAttribute("src");
        element.load();
        URL.revokeObjectURL(url);
    }
};

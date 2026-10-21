import { disallowedMediaUrls, localMediaId, previewMediaUrl, REFUSED_MEDIA_URL } from "./media-policy";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const APP = "opennan-app://app";

describe("previewMediaUrl", () => {
    it("maps imported media to the media protocol", () => {
        expect(previewMediaUrl(`opennan-local://media/${ID}`, APP)).toEqual({ url: `opennan-media://blob/${ID}`, allowed: true });
        expect(previewMediaUrl(`opennan-media://blob/${ID}`, APP)).toEqual({ url: `opennan-media://blob/${ID}`, allowed: true });
        expect(localMediaId(`opennan-local://media/${ID}`)).toBe(ID);
    });

    it("keeps the app's own blob and image data URLs", () => {
        expect(previewMediaUrl(`blob:${APP}/abc`, APP).allowed).toBe(true);
        expect(previewMediaUrl("data:image/png;base64,AAAA", APP).allowed).toBe(true);
    });

    it.each([
        "https://evil.test/a.mp4", "http://127.0.0.1:4319/x.mp4", "file:///etc/passwd", "C:\\x.mp4", "/abs/x.mp4", "x.mp4",
        `opennan-local://media/../${ID}`, `opennan-local://media/${ID}/x`, `opennan-media://blob/${ID}/../x`, "javascript:alert(1)",
        "blob:https://evil.test/abc", "data:text/html,<script>", "opennan-media://refused/x", "",
    ])("refuses %s", (url) => {
        const result = previewMediaUrl(url, APP);
        expect(result.allowed).toBe(false);
        expect(result.url.startsWith(REFUSED_MEDIA_URL)).toBe(true);
    });
});

describe("disallowedMediaUrls", () => {
    it("finds refused media at any depth", () => {
        expect(disallowedMediaUrls({ type: "clip.create", input: [{ mediaUrl: "https://x", trackType: "video" }] })).toEqual(["https://x"]);
        expect(disallowedMediaUrls({ type: "scene.update", sceneId: "s", patch: { videoUrl: "file:///y" } })).toEqual(["file:///y"]);
        expect(disallowedMediaUrls({ type: "clip.batch", command: { creates: [{ mediaUrl: "/abs.mp4" }] } })).toEqual(["/abs.mp4"]);
        expect(disallowedMediaUrls({ type: "project.update", patch: { musicUrl: "https://m" } })).toEqual(["https://m"]);
    });

    it("accepts local media, empty values, and non-media fields", () => {
        expect(disallowedMediaUrls({ type: "clip.create", input: { mediaUrl: `opennan-local://media/${ID}`, textContent: "https://x" } })).toEqual([]);
        expect(disallowedMediaUrls({ type: "clip.update", clipIds: ["c"], patch: { thumbnailUrl: null, audioUrl: "" } })).toEqual([]);
        expect(disallowedMediaUrls({ type: "playhead.seek", seconds: 3 })).toEqual([]);
    });
});

describe("disallowedMediaUrls (every *Url field, JSON strings, depth)", () => {
    it("covers fields beyond the common ones and URLs inside JSON strings", () => {
        expect(disallowedMediaUrls({ type: "scene.update", patch: { videoPosterUrl: "https://x/p.jpg", speechAudioUrl: "file:///a.wav" } })).toEqual(["https://x/p.jpg", "file:///a.wav"]);
        expect(disallowedMediaUrls({ type: "clip.create", input: { cardConfig: JSON.stringify({ shots: [{ videoUrl: "https://evil/x.mp4" }] }) } })).toEqual(["https://evil/x.mp4"]);
        expect(disallowedMediaUrls({ type: "clip.update", patch: { remotionPropsJson: "{\"imageUrl\":\"http://10.0.0.1/a.png\"}" } })).toEqual(["http://10.0.0.1/a.png"]);
        expect(disallowedMediaUrls({ media: { url: "https://x" } })).toEqual(["https://x"]);
    });

    it("refuses nesting deeper than the scan goes", () => {
        let deep: Record<string, unknown> = { mediaUrl: `opennan-local://media/${ID}` };
        for (let i = 0; i < 40; i += 1) deep = { child: deep };
        expect(disallowedMediaUrls(deep).length).toBeGreaterThan(0);
    });
});

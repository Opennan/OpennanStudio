import { extensionForMime, extensionOf, mediaKindOf, mediaKindOfItem } from "./media-kind";

describe("media kinds", () => {
    it("detects video, audio, and images by MIME type", () => {
        expect(mediaKindOf({ name: "a.bin", type: "video/webm" })).toBe("video");
        expect(mediaKindOf({ name: "a.bin", type: "audio/wav" })).toBe("audio");
        expect(mediaKindOf({ name: "a.bin", type: "image/png" })).toBe("image");
        expect(mediaKindOf({ name: "logo.svg", type: "image/svg+xml" })).toBeNull();
    });

    it("falls back to the extension when the type is empty", () => {
        expect(mediaKindOf({ name: "Clip.MKV", type: "" })).toBe("video");
        expect(mediaKindOf({ name: "voice.m4a", type: "" })).toBe("audio");
        expect(mediaKindOf({ name: "notes.txt", type: "" })).toBeNull();
        expect(mediaKindOf({ name: "notes.txt", type: "text/plain" })).toBeNull();
        expect(mediaKindOfItem({ name: "x.png", mimeType: "image/png" })).toBe("image");
    });

    it("maps MIME types to ffmpeg file extensions", () => {
        expect(extensionOf("a.tar.GZ")).toBe("gz");
        expect(extensionForMime("video/webm;codecs=vp9")).toBe("webm");
        expect(extensionForMime("image/jpeg")).toBe("jpg");
        expect(extensionForMime("", "clip.mov")).toBe("mov");
        expect(extensionForMime("application/octet-stream")).toBe("bin");
    });
});

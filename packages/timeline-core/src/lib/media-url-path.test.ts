import { getRawPathnameFromMediaUrl } from "./media-url-path";

describe("getRawPathnameFromMediaUrl", () => {
    it("returns the raw pathname of absolute, protocol-relative, rooted, and bare urls", () => {
        expect(getRawPathnameFromMediaUrl("https://cdn.test/a/b.mp4?x=1#t")).toBe("/a/b.mp4");
        expect(getRawPathnameFromMediaUrl("//cdn.test/c.mp3")).toBe("/c.mp3");
        expect(getRawPathnameFromMediaUrl("/uploads/d.png?v=2")).toBe("/uploads/d.png");
        expect(getRawPathnameFromMediaUrl("e.wav")).toBe("/e.wav");
    });
});

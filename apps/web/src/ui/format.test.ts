import { errorMessage, exportFileName, formatBytes, formatDuration, formatEdited } from "./format";

describe("format", () => {
    it("formats durations as m:ss or h:mm:ss", () => {
        expect(formatDuration(0)).toBe("0:00");
        expect(formatDuration(6.008)).toBe("0:06");
        expect(formatDuration(65.4)).toBe("1:05");
        expect(formatDuration(3_725)).toBe("1:02:05");
        expect(formatDuration(Number.NaN)).toBe("0:00");
    });

    it("describes when a project was edited", () => {
        const now = Date.UTC(2026, 9, 18, 12, 0, 0);
        expect(formatEdited(now - 5_000, now)).toBe("Edited just now");
        expect(formatEdited(now - 3 * 60_000, now)).toBe("Edited 3 min ago");
        expect(formatEdited(now - 2 * 3_600_000, now)).toBe("Edited 2 h ago");
        expect(formatEdited(now - 86_400_000, now)).toBe("Edited 1 day ago");
        expect(formatEdited(now - 3 * 86_400_000, now)).toBe("Edited 3 days ago");
        expect(formatEdited(Date.UTC(2026, 0, 5, 12), now)).toBe("Edited Jan 5, 2026");
    });

    it("formats sizes and errors", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(90_112)).toBe("88 KB");
        expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
        expect(errorMessage(new Error("boom"))).toBe("boom");
        expect(errorMessage("plain")).toBe("plain");
    });

    it("names the exported file after the project", () => {
        expect(exportFileName("Beach Trip!")).toBe("beach-trip.mp4");
        expect(exportFileName("  ")).toBe("opennan-studio.mp4");
    });
});

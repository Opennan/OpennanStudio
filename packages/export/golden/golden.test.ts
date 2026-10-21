// Golden export tests: render every fixture with the local ffmpeg, check streams and duration with
// ffprobe, compare sampled frames with preview snapshots (SSIM), and check the audio mix.
import { existsSync } from "node:fs";
import { speedRampTable } from "../src/filters/video";
import { GOLDEN_FIXTURES, goldenFixture } from "./fixtures";
import {
    channelFrequency, channelMeanVolume, counterIndices, exportFixture, ffmpegVersion, HAS_FFMPEG, meanColor, pixelAt, probeOutput, rowPixels,
    SNAPSHOT_FFMPEG, snapshotPath, ssimAt, ssimToBlend,
} from "./harness";

describe.skipIf(!HAS_FFMPEG)("golden exports", () => {
    beforeAll(() => {
        // Snapshots and thresholds were measured with this release; a Homebrew upgrade can shift SSIM.
        const version = ffmpegVersion();
        console.log(`golden ffmpeg ${version} (snapshots: ${SNAPSHOT_FFMPEG}.x)`);
        if (!version.startsWith(`${SNAPSHOT_FFMPEG}.`) && version !== SNAPSHOT_FFMPEG && !process.env.OPENNAN_GOLDEN_ANY_FFMPEG) {
            throw new Error(`golden tests expect ffmpeg ${SNAPSHOT_FFMPEG}.x, found ${version}; set OPENNAN_GOLDEN_ANY_FFMPEG=1 to run anyway`);
        }
    });

    for (const fixture of GOLDEN_FIXTURES) {
        it(`${fixture.name}: streams, duration, preview parity`, async () => {
            const { file, result } = await exportFixture(fixture);
            const probe = probeOutput(file);
            expect(Math.abs(probe.duration - fixture.duration)).toBeLessThan(0.07);
            expect(probe.video).toMatchObject({ width: result.width, height: result.height, fps: "30/1" });
            expect(probe.audio).toMatchObject({ sampleRate: 48000, channels: 2 });
            for (const time of fixture.samples) {
                const snapshot = snapshotPath(fixture.name, time);
                expect(existsSync(snapshot), `missing ${snapshot}: run pnpm --filter @opennan/playground golden:snapshots`).toBe(true);
                const ssim = ssimAt(file, time, snapshot);
                expect(ssim, `${fixture.name}@${time}s SSIM`).toBeGreaterThanOrEqual(fixture.ssimMin);
            }
        });
    }

    it("renders 720p, 1080p and 4K frames for each canvas preset", async () => {
        const base = goldenFixture("base-scenes");
        const expected: Record<string, Record<string, [number, number]>> = {
            "16:9": { "720p": [1280, 720], "1080p": [1920, 1080], "4k": [3840, 2160] },
            "9:16": { "720p": [720, 1280], "1080p": [1080, 1920], "4k": [2160, 3840] },
            "1:1": { "720p": [720, 720], "1080p": [1080, 1080], "4k": [2160, 2160] },
            "4:5": { "720p": [720, 900], "1080p": [1080, 1350], "4k": [2160, 2700] },
        };
        for (const [aspectRatio, sizes] of Object.entries(expected)) {
            for (const [resolution, [width, height]] of Object.entries(sizes)) {
                const { file } = await exportFixture({ ...base, name: `matrix-${aspectRatio.replace(":", "x")}`, aspectRatio }, resolution as "720p" | "1080p" | "4k");
                expect(probeOutput(file).video, `${aspectRatio} ${resolution}`).toMatchObject({ width, height });
            }
        }
    });

    it("renders timeline gaps black (the preview holds the last frame there)", async () => {
        const { file } = await exportFixture(goldenFixture("base-scenes"));
        expect(Math.max(...meanColor(file, 3.5))).toBeLessThan(8);
    });

    it("cross-dissolves from the held last frame after the cut", async () => {
        // After a seek the preview shows the outgoing scene's first frame instead of its held last frame,
        // so the dissolve midpoint is checked against the export's own frames: 50% of the last frame
        // before the cut (3.95 s) and 50% of the incoming static bars (4.55 s, after the 0.5 s fade).
        const { file } = await exportFixture(goldenFixture("transitions"));
        expect(ssimToBlend(file, 3.95, 4.55, 4.25)).toBeGreaterThan(0.95);
    });

    it("pans the clip hard left and fades it in", async () => {
        const { file } = await exportFixture(goldenFixture("audio-mix"));
        expect(channelMeanVolume(file, 0)).toBeGreaterThan(-35);
        expect(channelMeanVolume(file, 1)).toBeLessThan(-80);
        expect(channelMeanVolume(file, 0, 0, 0.25)).toBeLessThan(channelMeanVolume(file, 0, 1, 0.5) - 6);
    });

    it("kitchen sink: every clip filter renders together and only real approximations are reported", async () => {
        const { result } = await exportFixture(goldenFixture("kitchen-sink"));
        // encoder-fallback appears only where no H.264 encoder passes the self-test (some CI VMs).
        expect(result.warnings.map((w) => w.code).filter((code) => code !== "encoder-fallback"))
            // A legacy ramp is a step curve now: its audio segments are exact, so nothing is approximated.
            .toEqual(["remotion-unsupported"]);
    });

    // ── export-only checks (Task 18 table) ──
    const near = (pixel: number[], expected: number[], tolerance = 40) => pixel.every((value, i) => Math.abs(value - expected[i]) < tolerance);

    it("crop and flip: the bottom half, mirrored, inside its box", async () => {
        const { file } = await exportFixture(goldenFixture("crop-flip"));
        // quadrants.png is 107 px at 720p; cropTop 0.5 keeps 53 rows of blue | white; the flip reads white | blue.
        expect(near(pixelAt(file, 1, 20, 20), [255, 255, 255]), "left is white").toBe(true);
        expect(near(pixelAt(file, 1, 85, 20), [0, 0, 255]), "right is blue").toBe(true);
        expect(Math.max(...pixelAt(file, 1, 20, 70)), "nothing below the cropped box").toBeLessThan(30);
        expect(Math.max(...pixelAt(file, 1, 115, 20)), "nothing right of the box").toBeLessThan(30);
    });

    it("chroma key: keyed green shows the scene below, the rest stays", async () => {
        const { file } = await exportFixture(goldenFixture("chroma-key"));
        // keyed.png (107 px) is centered at (640, 360): green margin x ≈ 587-613, blue center 613-667.
        const margin = pixelAt(file, 1, 595, 360);
        expect(margin[0], "red scene shows through").toBeGreaterThan(180);
        expect(margin[1], "no green left").toBeLessThan(80);
        const center = pixelAt(file, 1, 640, 360);
        expect(center[2]).toBeGreaterThan(180);
        expect(center[0]).toBeLessThan(80);
    });

    it("mosaic: 8 px blocks", async () => {
        const { file } = await exportFixture(goldenFixture("mosaic"));
        // image.png is 213 px wide at 720p; mosaic 8 yields 26 blocks of 8 px from x = 0.
        const row = rowPixels(file, 1, 60);
        const blocks = Array.from({ length: 26 }, (_, i) => [row[i * 8 + 2], row[i * 8 + 5]]);
        expect(blocks.filter(([a, b]) => near(a, b, 17)).length, "pixels inside a block match").toBeGreaterThanOrEqual(23);
        expect(new Set(blocks.map(([a]) => a.map((v) => v >> 5).join())).size, "blocks differ").toBeGreaterThanOrEqual(5);
    });

    it("reverse, freeze and speed ramps keep the source frame order", async () => {
        const { file } = await exportFixture(goldenFixture("time-effects"));
        const reversed = counterIndices(file, 0, 1);
        expect(reversed).toHaveLength(30);
        expect(reversed[0]).toBe(29);
        reversed.slice(1).forEach((index, i) => expect(index, `reverse frame ${i + 1}`).toBe(reversed[i] - 1));
        expect(new Set(counterIndices(file, 1, 1))).toEqual(new Set([0]));
        // hero over 3 s: frames only move forward, repeats only as long as the 0.45× segment needs,
        // distinct frames as the ramp table predicts, and the clip reaches the end of its source span.
        const ramp = counterIndices(file, 2, 3);
        expect(ramp).toHaveLength(90);
        ramp.slice(1).forEach((index, i) => expect(index, `ramp frame ${i + 1}`).toBeGreaterThanOrEqual(ramp[i]));
        let run = 1;
        let longest = 1;
        ramp.slice(1).forEach((index, i) => {
            run = index === ramp[i] ? run + 1 : 1;
            longest = Math.max(longest, run);
        });
        expect(longest, "longest repeat").toBeLessThanOrEqual(Math.ceil(1 / 0.45));
        const table = speedRampTable("hero", 3, 1)!;
        const expectedDistinct = table.segments.reduce((sum, segment, i) => {
            const next = table.segments[i + 1];
            const outFrames = ((next?.outputStart ?? 3) - segment.outputStart) * 30;
            const sourceFrames = ((next?.sourceStart ?? table.sourceSpan) - segment.sourceStart) * 30;
            return sum + Math.min(outFrames, sourceFrames);
        }, 0);
        expect(Math.abs(new Set(ramp).size - expectedDistinct)).toBeLessThanOrEqual(3);
        expect(Math.abs(ramp[ramp.length - 1] - (table.sourceSpan * 30 - 1))).toBeLessThanOrEqual(2);
    });

    it("pitch after normalize and pan: +12 semitones of 440 Hz is 880 Hz, left 6 dB down", async () => {
        const { file } = await exportFixture(goldenFixture("audio-filters"));
        for (const channel of [0, 1] as const) {
            const hz = channelFrequency(file, channel, 0.5, 1);
            expect(hz, `channel ${channel} frequency`).toBeGreaterThan(860);
            expect(hz).toBeLessThan(900);
        }
        const drop = channelMeanVolume(file, 1, 0.5, 1) - channelMeanVolume(file, 0, 0.5, 1);
        expect(drop).toBeGreaterThan(4);
        expect(drop).toBeLessThan(8);
    });

    it("motion preset zoom_in grows the clip 8% over its length", async () => {
        const { file } = await exportFixture(goldenFixture("motion-preset"));
        const redWidth = (time: number) => rowPixels(file, time, 360).filter(([r, , b]) => r > 128 && b < 96).length;
        const first = redWidth(0);
        const last = redWidth(2.95);
        // sticker.png's circle is 140 of 160 px; × scale 2 × 2/3 (720p) ≈ 187 px.
        expect(Math.abs(first - 187)).toBeLessThanOrEqual(6);
        expect(last / first).toBeGreaterThan(1.06);
        expect(last / first).toBeLessThan(1.1);
    });

    it("shot-sequenced scenes play each shot's own video", async () => {
        const { file } = await exportFixture(goldenFixture("shot-sequence"));
        const [r1, , b1] = meanColor(file, 1);
        const [r2, , b2] = meanColor(file, 2.5);
        expect([r1 > 150, b1 < 60], "shot 1 is red").toEqual([true, true]);
        expect([b2 > 150, r2 < 60], "shot 2 is blue").toEqual([true, true]);
    });
});

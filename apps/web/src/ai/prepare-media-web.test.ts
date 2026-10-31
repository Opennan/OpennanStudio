import { audioContainer, encodeWav, rangeToSend, scaledToMinPixels } from "./prepare-media-web";

const purpose = (contentTypes: string[], maxBytes = 200 * 1024 * 1024) => ({ output: "audio" as const, maxBytes, contentTypes });

describe("web media preparer helpers", () => {
    it("sends the reference's range inside the file, cut to the destination's cap", () => {
        expect(rangeToSend(30, 2, 12, undefined)).toEqual({ start: 2, end: 12 });
        expect(rangeToSend(30, 2, 120, undefined)).toEqual({ start: 2, end: 30 });
        expect(rangeToSend(300, 10, 200, 60)).toEqual({ start: 10, end: 70 });
        expect(rangeToSend(30, undefined, undefined, undefined)).toEqual({ start: 0, end: 30 });
        expect(() => rangeToSend(10, 12, 15, undefined)).toThrow(/empty/);
    });

    it("picks WAV, or AAC in MP4 when WAV would pass the cap (stems take at most 50 MB)", () => {
        expect(audioContainer(purpose(["audio/wav"]), 600, 44100)).toBe("wav");
        expect(audioContainer(purpose(["audio/wav", "audio/mp4"], 50 * 1024 * 1024), 15 * 60, 44100)).toBe("mp4");
        expect(audioContainer(purpose(["audio/wav", "audio/mp4"], 50 * 1024 * 1024), 60, 44100)).toBe("wav");
        expect(audioContainer(purpose(["audio/mp4", "audio/wav"]), 60, 44100)).toBe("mp4");
        expect(audioContainer(purpose(["audio/mp4"]), 60, 44100)).toBe("mp4");
    });

    it("uses accepted WAV when AAC is unavailable, while enforcing the destination's size and format limits", () => {
        const stems = purpose(["audio/mp4", "audio/wav"], 50 * 1024 * 1024);
        expect(audioContainer(stems, 3.2, 44100, false)).toBe("wav");
        expect(() => audioContainer(stems, 900, 44100, false)).toThrow(/shorter range/i);
        expect(() => audioContainer(purpose(["audio/mp4"]), 3.2, 44100, false)).toThrow(/AAC/i);
    });

    it("encodes 16-bit mono PCM WAV", () => {
        const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
        const view = new DataView(wav);
        expect(wav.byteLength).toBe(44 + 8);
        expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe("RIFF");
        expect(view.getUint32(24, true)).toBe(16000);
        expect(view.getInt16(46, true)).toBe(32767);
        expect(view.getInt16(48, true)).toBe(-32768);
    });
});

describe("scaledToMinPixels", () => {
    it("keeps a picture that is large enough and scales a small one up to the minimum, shape kept, sides even", () => {
        expect(scaledToMinPixels(1280, 720, 409_600)).toEqual({ width: 1280, height: 720 });
        expect(scaledToMinPixels(640, 360, undefined)).toEqual({ width: 640, height: 360 });
        const up = scaledToMinPixels(640, 360, 409_600);
        expect(up.width * up.height).toBeGreaterThanOrEqual(409_600);
        expect(up.width % 2 + up.height % 2).toBe(0);
        expect(Math.abs(up.width / up.height - 16 / 9)).toBeLessThan(0.01);
        expect(up).toEqual({ width: 854, height: 480 });
        const tall = scaledToMinPixels(360, 640, 409_600);
        expect(tall.width * tall.height).toBeGreaterThanOrEqual(409_600);
        expect(tall.height).toBeGreaterThan(tall.width);
    });
});

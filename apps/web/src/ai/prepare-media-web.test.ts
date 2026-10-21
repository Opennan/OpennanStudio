import { audioContainer, encodeWav, rangeToSend } from "./prepare-media-web";

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

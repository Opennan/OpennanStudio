// Real whisper.cpp on test/fixtures/jfk.wav with the tiny model. Runs when both exist:
//   binary folder: OPENNAN_WHISPER_DIR, else apps/desktop/resources/whisper/<platform>-<arch> (pnpm --filter @opennan/desktop fetch:whisper)
//   model:         OPENNAN_WHISPER_MODEL, else <repo>/.cache/whisper-models/ggml-tiny.bin (the desktop smoke's cache)
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWhisperBinary } from "./binary";
import { sha256File } from "./model-store";
import { findWhisperModel } from "./models";
import { runWhisper } from "./whisper-runner";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_DIR = process.env.OPENNAN_WHISPER_DIR ?? path.join(REPO, "apps/desktop/resources/whisper", `${process.platform}-${process.arch}`);
const MODEL = process.env.OPENNAN_WHISPER_MODEL ?? path.join(REPO, ".cache/whisper-models/ggml-tiny.bin");
const WAV = fileURLToPath(new URL("../test/fixtures/jfk.wav", import.meta.url));
const AVAILABLE = existsSync(path.join(BINARY_DIR, "checksums.json")) && existsSync(MODEL);

describe.skipIf(!AVAILABLE)("whisper.cpp on jfk.wav (integration)", () => {
    it("transcribes the fixture with the tiny model", async () => {
        expect(await sha256File(MODEL)).toBe(findWhisperModel("tiny")!.sha256);
        const binary = await loadWhisperBinary(BINARY_DIR);
        const progress: number[] = [];
        const transcript = await runWhisper({ binary, modelPath: MODEL, wavPath: WAV, language: "auto", onProgress: (r) => progress.push(r) });
        expect(transcript.language).toBe("en");
        expect(transcript.segments.map((s) => s.text).join(" ")).toMatch(/ask not what\s+your country can do for you/i);
        const last = transcript.segments.at(-1)!;
        expect(last.end).toBeGreaterThan(10);
        expect(last.end).toBeLessThan(11.2);
        expect(progress.at(-1)).toBe(1);
        // -ojf: every segment carries word timings that spell its text, in order, inside the segment.
        for (const segment of transcript.segments) {
            expect(segment.words?.map((w) => w.text).join(" ")).toBe(segment.text);
            let previous = segment.start;
            for (const word of segment.words!) {
                expect(word.start).toBeGreaterThanOrEqual(previous);
                expect(word.end).toBeGreaterThanOrEqual(word.start);
                expect(word.end).toBeLessThanOrEqual(segment.end);
                previous = word.end;
            }
        }
    });
});

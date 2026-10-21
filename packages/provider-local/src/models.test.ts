import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS, WHISPER_MODEL_REVISION, findWhisperModel } from "./models";
import { isAllowedDownloadHost } from "./download";

describe("whisper model catalog", () => {
    it("pins every model to one revision, an HTTPS Hugging Face URL, a size, and a SHA-256", () => {
        expect(WHISPER_MODELS.map((m) => m.id)).toEqual(["tiny", "base", "small"]);
        for (const model of WHISPER_MODELS) {
            expect(model.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-${model.id}.bin`);
            expect(model.file).toBe(`ggml-${model.id}.bin`);
            expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(model.sizeBytes).toBeGreaterThan(10_000_000);
            expect(model.license).toBe("MIT");
            expect(isAllowedDownloadHost(new URL(model.url).hostname)).toBe(true);
        }
        expect(WHISPER_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
        expect(DEFAULT_WHISPER_MODEL).toBe("base");
        expect(findWhisperModel("tiny")?.sizeBytes).toBe(77_691_713);
        expect(findWhisperModel("../tiny")).toBeUndefined();
    });

    it("allows only Hugging Face hosts", () => {
        for (const host of ["huggingface.co", "cdn-lfs.huggingface.co", "us.aws.cdn.hf.co", "HF.CO"]) expect(isAllowedDownloadHost(host)).toBe(true);
        for (const host of ["evil.example", "huggingface.co.evil.example", "hf.com", "nothf.co", "xhuggingface.co"]) expect(isAllowedDownloadHost(host)).toBe(false);
    });
});

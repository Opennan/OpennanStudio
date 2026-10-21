// Whisper models (ggml format) from the whisper.cpp project's Hugging Face repository, pinned to one revision
// and SHA-256 (Hugging Face LFS hashes, verified locally for tiny). Weights: OpenAI Whisper, MIT License.
export const WHISPER_MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const BASE_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}`;

export type WhisperModelId = "tiny" | "base" | "small";

export interface WhisperModel {
    id: WhisperModelId;
    label: string;
    file: string;
    url: string;
    sizeBytes: number;
    sha256: string;
    license: "MIT";
}

const model = (id: WhisperModelId, label: string, sizeBytes: number, sha256: string): WhisperModel => ({
    id, label, file: `ggml-${id}.bin`, url: `${BASE_URL}/ggml-${id}.bin`, sizeBytes, sha256, license: "MIT",
});

export const WHISPER_MODELS: readonly WhisperModel[] = [
    model("tiny", "Tiny (fastest)", 77_691_713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"),
    model("base", "Base", 147_951_465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
    model("small", "Small (most accurate)", 487_601_967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"),
];

export const DEFAULT_WHISPER_MODEL: WhisperModelId = "base";

export function findWhisperModel(id: string, catalog: readonly WhisperModel[] = WHISPER_MODELS): WhisperModel | undefined {
    return catalog.find((entry) => entry.id === id);
}

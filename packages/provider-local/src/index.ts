// Public API of @opennan/provider-local (Apache-2.0, spec §5.9): the on-device provider. Node only.
export const PROVIDER_LOCAL_VERSION = "0.3.0";

export { parseWhisperJson, parseProgressLine } from "./whisper-output";
export { buildWhisperArgs, checkAbsolutePath, type WhisperArgsInput } from "./whisper-args";
export { WHISPER_MODELS, WHISPER_MODEL_REVISION, DEFAULT_WHISPER_MODEL, findWhisperModel, type WhisperModel, type WhisperModelId } from "./models";
export { downloadVerified, isAllowedDownloadHost, type DownloadOptions } from "./download";
export { createModelStore, sha256File, type ModelStore, type ModelStoreOptions, type EnsureOptions, type ModelProgress } from "./model-store";
export { loadWhisperBinary, verifyWhisperBinary, whisperExecutableName, WHISPER_CHECKSUM_MISMATCH, type WhisperBinary } from "./binary";
export { runWhisper, whisperEnv, type RunWhisperOptions } from "./whisper-runner";
export { createLocalProvider, defaultThreads, LOCAL_PROVIDER_ID, LOCAL_PROVIDER_NAME, type LocalProviderOptions, type PreparedAudio } from "./local-provider";

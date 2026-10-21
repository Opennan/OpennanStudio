# @opennan/provider-local

The free, offline provider of OpenNan Studio (spec §5.9). Apache-2.0, Node 20+, depends only on `@opennan/provider-sdk`.

- `createLocalProvider({ whisperDir, models, prepareAudio })` → a `Provider` with id `local`, `info.onDevice: true` (it wins the default captions route over OpenNan cloud), and `audio.transcribe`. Each job runs three phases on one progress scale: the model (downloaded and verified on first use), the audio (the host prepares a 16 kHz mono WAV; the desktop app renders the timeline mix, or trims a media file's source range when the input is `{ kind: "media", url, startSeconds, endSeconds }`), and [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT).
- `runWhisper()` spawns `whisper-cli` with an argument list (no shell), a minimal environment, and a private temp folder, after `loadWhisperBinary()` has checked the binary and every library listed in its folder's `checksums.json` against their SHA-256. Cancel sends SIGTERM, then SIGKILL.
- `WHISPER_MODELS`: tiny, base (default), small, from `huggingface.co/ggerganov/whisper.cpp` at a pinned revision, each with its size and SHA-256 (OpenAI Whisper weights, MIT). `createModelStore({ dir })` downloads only catalog files, over HTTPS, following redirects only to Hugging Face hosts, streaming through SHA-256 into a temporary file renamed into place only when size and hash match.
- `parseWhisperJson()`, `parseProgressLine()`, `buildWhisperArgs()` for other hosts.

Test fixture `test/fixtures/jfk.wav` is whisper.cpp's `samples/jfk.wav`: John F. Kennedy's 1961 inaugural address, a work of the US government in the public domain. `src/integration.test.ts` runs the real binary on it when `OPENNAN_WHISPER_DIR` (or `apps/desktop/resources/whisper/<platform>-<arch>`) and `OPENNAN_WHISPER_MODEL` (or `.cache/whisper-models/ggml-tiny.bin`) exist.

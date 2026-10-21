# @opennan/provider-fal

fal.ai provider for OpenNan Studio (spec §5.6), the reference community adapter. Apache-2.0. Bring your own fal key: fal bills you directly, and the key is sent only to `https://queue.fal.run` and fal's storage API `https://rest.alpha.fal.ai`.

- Capabilities: `image.generate` (FLUX.1 schnell/dev), `video.text-to-video` and `video.image-to-video` (Kling 2.1 Standard), and (0.2.0) `audio.isolate-voice` (`fal-ai/elevenlabs/audio-isolation`) and `video.upscale` (`fal-ai/bytedance-upscaler/upscale/video`, 1080p / 2k / 4k).
- Project media (0.2.0): `createFalProvider({ getKey, prepareMedia })`. A media input given as a `MediaSourceRef` (`source`, or `image` for image-to-video) is made by the host's preparer and uploaded to fal storage (`POST …/storage/upload/initiate` → `PUT upload_url` without the key, no redirects → fal reads `file_url`; both must be https); https links pass straight through.
- `price()` answers `{ kind: "billed-elsewhere", by: "fal.ai" }`: fal bills the user's own account.
- `createFalProvider({ getKey })` returns a `Provider` whose `run()` jobs use fal's queue API (submit, poll the status URL, read the response; cancel through the cancel URL). Queue URLs other than `queue.fal.run` are refused.
- A missing or refused key fails the job with a `CapabilityUnavailableError` whose message tells the person to add the key in Settings → AI providers.

OpenNan Studio registers it when a fal key is stored (web: in the browser's account storage; desktop: in the system keychain through main, where the jobs run).

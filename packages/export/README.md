# @opennan/export

Local video export for the OpenNan editor. `compileExport` turns the timeline the preview plays
(`TimelineData` + `SceneData[]`) into one ffmpeg filter graph plus its inputs; a runner executes it.

- `@opennan/export`: pure compile, encoder choice, `exportTimeline`, `createExportSession`.
- `@opennan/export/node`: native ffmpeg (`createNodeRunner({ ffmpegPath, ffprobePath, outputPath, mediaRoots })`).
  Ship an LGPL ffmpeg build: H.264 comes from h264_videotoolbox, h264_mf, h264_vaapi or libopenh264
  (probed with `ffmpeg -encoders` plus a one-frame self-test); libx264 only with `allowGpl: true`;
  MPEG-4 Part 2 is the last resort every build has (reported as `encoder-fallback`).
  Media access fails closed: only files under `mediaRoots` (plus what `resolveSource` maps there),
  http(s) only with `allowNetworkMedia`, and every input runs with `-protocol_whitelist file,pipe` and a
  plain-media `-format_whitelist`. Do not widen this for agent-triggered renders (`previewFrame`).
- `@opennan/export/web`: ffmpeg.wasm (`createWasmRunner`), browser canvas text (`createBrowserRasterizer`),
  `createFetchMediaReader` (auth headers only to the app's own origin or `authOrigins`). Up to 1080p,
  no GL passes, a media budget (`too-large` above it). The GPL `@ffmpeg/core` is never bundled: serve it
  next to the app (default `coreBaseUrl` `/ffmpeg-core`); `loadVerifiedFfmpegCore` checks its pinned SHA-256
  before it runs. Self-hosting distributes a GPL binary; ship its notice and source offer.
- `@opennan/export/web-gl`: `createWebGlFrameProcessor()` runs GL effect stacks with the preview's
  `EffectRenderer` (browser or Electron renderer); the node runner pipes frames through it.
- `createRemoteRasterizer` / `createRemoteGlFrameProcessor` and `serveOverlayRasterizer` /
  `serveGlFrameProcessor`: the same over a `MessagePort`, for a node runner in Electron's main process.
- `createExportFrameRenderer({ runner, rasterizer })`: one PNG frame of the timeline (the read API's
  `previewFrame`); needs a runner with `renderFrame` (the node runner). Without a rasterizer, text and
  emoji are left out with `text-unsupported`.

```ts
import { exportTimeline } from "@opennan/export";
import { createBrowserRasterizer, createFetchMediaReader, createWasmRunner } from "@opennan/export/web";

const runner = createWasmRunner({ readMedia: createFetchMediaReader(media) });
const result = await exportTimeline(input, { resolution: "1080p" }, { runner, rasterizer: createBrowserRasterizer() });
```

## What matches the preview

Scene placement, gaps, trims, fit/scale/offset, canvas presets (9:16, 16:9, 1:1, 4:5) at 720p/1080p/4K,
dip and dissolve transitions, V2+ scenes and overlay clips, image and emoji stickers, text (drawn by the
preview's own layout and drawing code), keyframed position/scale/rotation/opacity, overlay speed, and
the audio the preview plays (active scene audio or voiceover, soundtrack, audio clips, overlay clip audio)
with the same faders and mute rules. `pnpm --filter @opennan/export test:golden` checks this against
committed preview snapshots (SSIM).

## Export-only features

The preview does not render these; the export follows the reference assembler: crop, flip, brightness,
contrast, saturation, filter presets, blur, chroma key, blend-mode looks, mosaic, speed ramps, reverse,
freeze frame, clip fades and clip transitions, motion presets, and audio pan, pitch, EQ, denoise,
normalize and speed. Golden export-only fixtures check each output directly (pixels, frame order,
frequency, levels). Speed (0.1-100×, curves, and legacy ramps as their step curves) is one remap through
the clip's or scene's speed profile: output frame n shows the source frame visible at the middle of the
frame, S((n + ½)/fps), exactly on native ffmpeg and ffmpeg.wasm (`parity/speed.parity.test.ts`). Audio
follows the same time map in segments (atempo keeps pitch, asetrate lets it follow); steep curves whose
audio can drift more than a frame from the picture report `speed-ramp-audio-approximated`.

Motion (phase 10b) is timeline-core's transform model (`motion/transform.ts`): keyframes with easing, clip
and text animations, legacy fades and motion presets as one expression per channel, which the preview
evaluates too. Overlays and moving scenes are scaled, padded, rotated, and placed per frame from those
expressions (`parity/motion.parity.test.ts`: every channel on both hosts against the JS evaluator, and a
rendered square and scenes against the preview's own placement). Adjust keyframes cross-fade one Hald CLUT
per keyframe with the eased weight (`parity/lut-keyframes.parity.test.ts`); at most 8 keyframes export
(`look-keyframes-limited`).

## Known differences

- Gaps export black. After a seek the preview keeps showing the last frame.
- A dissolve out of a letterboxed scene also fades its black bars; the preview fades only the picture.
- `blur_dissolve` uses ffmpeg's `fadegrays`, as the reference assembler does; slide, wipe and zoom use the
  matching `xfade` transitions.
- Animated text is drawn once at its largest scale and scaled per frame; its line wrapping does not change
  while the scale animates.
- Remotion graphics clips are not exported yet (`remotion-unsupported` warning, phase 9).
- GL effects need a runner with GL support and a `GlFrameProcessor`; otherwise each is reported with
  `gl-effect-unsupported` and left out.
- Shot-sequenced scenes (no stitched video, every shot with its own `video_url`) export shot by shot as
  the preview plays them, without the preview's 120 ms opacity cross-fade between shots.
- The web app exports MPEG-4 Part 2 unless the build opts in to libx264 (`VITE_WEB_EXPORT_ALLOW_GPL`),
  pending legal review; the desktop app exports H.264 through LGPL encoders.

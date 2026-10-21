# @opennan/provider-sdk

The AI provider interface of OpenNan Studio (spec §5.4). Apache-2.0, no runtime dependencies, runs in browsers and Node.

- **Capabilities**: `OPEN_CAPABILITIES` (any provider), `OPENNAN_CAPABILITIES` (only provider id `opennan`, spec §2.1), `PROVIDER_RUNTIME_CAPABILITIES`, and `capabilityUnavailableMessage(feature, capability)`, the guidance a UI or MCP tool shows when nothing offers a capability. `@opennan/mcp-schema` re-exports them.
- **`Job<T>`**: `id`, `status()` (`queued | running | succeeded | failed | cancelled`), `result()`, `cancel()`, and `subscribe(listener)` for `{ status, progress, message }` updates. `createJob(run)` builds one from an async function that gets an `AbortSignal` and a `report(progress, message)` callback. A failed job rejects with `JobFailedError` (the provider's message), a cancelled one with `JobCancelledError`.
- **`ProviderRegistry`**: `register()` (throws `ProviderRegistrationError` when a provider other than `opennan` declares an `opennan.*` capability, on a duplicate id, or on an unknown capability), routing per capability (a `setRoute` override, then `opennan`, then the first provider that declares it; `setOpenNanDefault(false)` routes open capabilities only to an override or a provider other than `opennan`, while `opennan.*` stays on OpenNan), `require()` (throws `CapabilityUnavailableError`, shown as guidance), and `subscribe()`/`version()` for UI stores.
- **Capability-gated UI**: `capabilityGate(registry, capability, feature)` → `{ available, providerName }` or `{ available: false, reason: "connect-opennan" | "needs-provider", message }`. Features stay visible and explain what they need.
- **Generic calls (0.2.0)**: `Provider.run({ capability, input, projectId })` returns a `Job<CapabilityOutput>` (`{ media: GeneratedMedia[]; result?; costUsd? }`, each media a `url` or `bytes`) for every capability besides `audio.transcribe`, which keeps its typed method; `Provider.models(capability)` lists models. A `CapabilityUnavailableError` thrown inside a job passes through as the job's failure (guidance such as "sign in"), other errors become `JobFailedError`.
- **`createAiRunner(registry, { importMedia })`**: the editor's `ai.run` handler (`TimelineControllerOptions.onAiRun`, `TimelineProvider onAiRun`): validates the input, runs the routed provider's job, forwards progress, cancels on the caller's signal, and returns the output plus a placement (`placeAt: { kind: "captions-track" }` → caption cues). For generation it hands each media to the host's `importMedia` (store it in the project's library) and returns the local URLs.
- **Transcription**: `TranscribeRequest`, `Transcript`, `WHISPER_LANGUAGES` (whisper.cpp's 100 languages), `transcriptToCaptionCues()` (markers dropped, long lines split, no overlaps), `transcriptText()`.
- **Contract**: `providerContractCases(provider)`, framework-free cases every adapter's tests run (spec §11).

```ts
import { ProviderRegistry, createAiRunner } from "@opennan/provider-sdk";

const providers = new ProviderRegistry();
providers.register(myProvider);
<TimelineProvider onAiRun={createAiRunner(providers)} … />
```

## Phase 11 (0.4.0): prices, media references, refusable cancel

- **Prices**: `Provider.price({ capability, input, units })` answers a `PriceAnswer`: `estimate` (`{ microUsd, usd, label: "≈ $0.005", units, capped }`), `free`, `billed-elsewhere` (`{ by: "fal.ai" }`), `over-limit` (`{ kind, max, actual }`), `unavailable` (`{ reason }`: the tool is not live) or `unknown` (offline: the run may still ask the server). Providers that publish price blocks build estimates with `estimateToolCost(block, units)` and the model estimators (`estimateImageCost`, `estimateVideoModelCost`, `estimateVoiceCost`, `estimateMusicCost`, `estimateStemsCost`, `estimateSoundEffectCost`). The rule never shows less than the run settles at: integer micro-dollars, a decoded-length margin (`BILLING_SAFETY`: 0.25 s + 0.5 %) before rounding up to started units, capped at the tool's hold, and the label rounded up. `captionBilledCharacters(segments)` counts what caption translation bills.
- **Media references**: `ai.run` inputs stay small JSON (`MAX_RUN_INPUT_BYTES`). A media tool names `{ mediaUrl, startSeconds?, endSeconds? }` (`MediaSourceRef`, checked by `parseMediaSourceRef`); the provider asks its host's `MediaPreparer` for the file (`MediaPreparePurpose`: audio or video, sample rate, size and length caps, content types) and uploads it where its key lives.
- **Cancel**: inside `createJob`, `context.onCancel(handler)` lets the provider decide a cancel. `true` cancels; `false` (a paid step started) keeps the job running with `cancellable: false` and the message `CANCEL_REFUSED_MESSAGE` ("Already running: it will finish and be charged."). Failed jobs carry `JobFailedError.code` and `refunded`.
- **Routing**: `ON_DEVICE_FIRST_CAPABILITIES` (`audio.transcribe`) route to a provider with `info.onDevice` before OpenNan; `LOCAL_ONLY_CAPABILITIES` (`media.stabilize`) are refused from provider `opennan`; `registry.providerFor(capability, { onDevice })` picks an engine for one run.
- **Runner**: `createAiRunner(registry, { importMedia, jobs })`. `audio.transcribe` takes `source: "timeline" | MediaSourceRef` and `engine: "local" | "cloud"`. `placeAt` (checked before anything runs) → `placement`: `captions-track { style, timeOffset?, timeScale?, label? }` (cue time t lands at `timeOffset + t / timeScale`), `captions-track-translated { sourceTrackIndex, language, keepSource, style? }` (from a `captions.translate` result), `replace-audio { source, range? }`, `stack-video { source, range?, hideSource?, muteSource? }`, `insert-media { at }` (with the imported media and their `role`, such as a stem). Progress events forward `cancellable`; a run whose cancel was refused still returns (and places) its result.
- **Job book**: `AiJobBook` records every runner job (`status`, `progress`, `message`, `cancellable`, `costUsd`, `error`, `refunded`, `startedAt`, `finishedAt`): `get(id)`, `list()` (newest first, at most 200), `subscribe()`, `version()`.

## Phase 11.1 (0.5.0): quoted estimates, cancel refusals with a message

- `CostEstimate.source` (`"quote"` for a server quote, `"estimate"` for the local upper bound) and `holdUsd` (what the run holds while it goes); `quotedEstimate({ priceUsd, holdUsd, units })` builds one (label rounded up, hold never below the settle); `paddedSeconds(seconds, max?)` is the decode margin a per-unit quote is asked with.
- A cancel handler may answer `{ accepted: false, message }` (`CancelAnswer`): the job keeps running and shows that message (e.g. "It had already finished.").

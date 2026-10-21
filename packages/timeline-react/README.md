# @opennan/timeline-react

The OpenNan video editor as React components.

    import "@opennan/timeline-react/styles.css";
    import { TimelineProvider, Timeline, Preview, ClipProperties } from "@opennan/timeline-react";

`<TimelineProvider backend projectId media>` owns one `TimelineController`; every edit is an `EditorCommand`. Hosts do not need Tailwind.

Peer dependencies: `react`, `react-dom`, and `regl` (`<Preview>` draws clip effects with it). Install `mediabunny` for WebCodecs thumbnails (loaded lazily) and `emoji-mart` + `@emoji-mart/data` for the sticker picker.

## Theme

The editor uses the OpenNan theme from opennan.com, which is dark only. Every color, radius, shadow, focus ring, and font stack is a CSS custom property in `src/theme/tokens.css`, shipped inside `styles.css` and on its own as `@opennan/timeline-react/theme.css`. The tokens apply under the editor roots and under `.opennan-theme`, a class that only carries the tokens, so a host can style its own chrome with `var(--on-*)`. The fonts the tokens name, Inter and Hubot Sans (both SIL OFL 1.1), are not bundled here: load them in the host (for example `@fontsource-variable/inter` and `@fontsource-variable/hubot-sans`), or the stacks fall back to system fonts.

## AI in the editor (phase 11)

`<TimelineProvider ai={host}>` takes a `TimelineAiHost` (see `ai/ai-host.ts`): the host prices each run from its
providers ("≈ $x · Run", never below what the run settles at), opens its sign-in, queues jobs, and runs `ai.run` on
the controller. With it the editor shows an **AI** inspector tab, an **AI** library tab, and an AI group in the clip
menu; `AiJobTray` lists the jobs (mount it where the host wants it). Without a host, the free on-device tools still
work: Remove silences, Remove filler words, Detect beats (with Snap to beats in the toolbar), and Auto cut to beat.
`analyzer` (default: `createBrowserAnalyzer`, mediabunny decoding with the detectors in a worker) runs
`analysis.run`; pass `null` to turn it off. Exports: `AiActionButton`, `AiJobTray`, `useAiHost`, `useAiTool`,
`useAiJobs`, `createBrowserAnalyzer`.

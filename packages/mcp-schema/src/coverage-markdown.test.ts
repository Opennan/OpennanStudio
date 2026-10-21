import { renderCoverageMarkdown } from "./coverage-markdown";
import { OPENNAN_TOOL_NAMES } from "./opennan-tool-names";

describe("renderCoverageMarkdown", () => {
    const md = renderCoverageMarkdown();

    it("has one row per OpenNan tool plus studio additions", () => {
        for (const name of OPENNAN_TOOL_NAMES) expect(md).toContain(`| \`${name}\` |`);
        expect(md).toContain("| `run_editor_command` | studio | command | any `EditorCommand` | offline |");
        expect(md).toContain("| `get_export_status` | studio | read | `exportStatus()` | offline; jobs started by `assemble_video` |");
        expect(md).toContain("| `track_motion` | studio | command | `tracking.run`, `tracking.apply`, `snapshot()` | offline, on the device; needs an editor window that decodes video (headless: unavailable) |");
    });

    it("states the mapping and phase 5 behavior", () => {
        expect(md).toContain("| `split_timeline_clip` | opennan | command | `clip.split` | offline |");
        expect(md).toContain("| `read_timeline` | opennan | read | `snapshot()`, `describeTimeline()` | offline |");
        expect(md).toContain("| `generate_storyboard` | opennan | capability | capability `opennan.story.storyboard` | OpenNan cloud projects: quoted by OpenNan first (`accept_max_usd` refuses above it), then the task's result lands in the editor as one undo step; local projects: save to OpenNan first; unavailable headless |");
        expect(md).toContain("| `set_copy_video_source` | opennan | capability | capability `opennan.copy-video` | OpenNan cloud projects: a no-charge edit OpenNan makes at once, synced into the editor; local projects: save to OpenNan first; unavailable headless |");
        expect(md).toContain("| `plan_scenes` | studio | host | editor UI (host) | OpenNan cloud projects: quoted by OpenNan first (`accept_max_usd` refuses above it), then the task's result lands in the editor as one undo step; local projects: save to OpenNan first; unavailable headless |");
        expect(md).toContain("| `set_project_script` | studio | host | editor UI (host) | OpenNan cloud projects: stores the script and subtitles on the project (no scene changes); local projects: save to OpenNan first; unavailable headless |");
        expect(md).toContain("| `qc_check` | opennan | capability | capability `opennan.qc` | unavailable: Connect OpenNan |");
        expect(md).toContain("| `generate_tts` | opennan | capability | capability `audio.tts` | runs `ai.run` on the routed provider (OpenNan by default; signed out: the sign-in guidance); the media lands in the project's library |");
        expect(md).toContain("| `clone_voice` | opennan | capability | capability `audio.voice-clone` | unavailable: needs a provider |");
        expect(md).toContain("| `create_scenes` | opennan | command | `scene.add`, `scene.update`, `scene.delete` | offline; `opennan.story.plan` fields refused |");
        expect(md).toContain("| `assemble_video` | opennan | command | `export.start` | runs `export.start` on `@opennan/export` when the host has an exporter (headless: `--ffmpeg`), else unavailable |");
        expect(md).toContain("| `preview_timeline_frame` | opennan | read | `previewFrame()`, `snapshot()` | offline; the image needs a frame renderer (headless: `--ffmpeg`) |");
        expect(md).toContain("| `ask_user_question` | opennan | not exposed | none |");
        expect(md.endsWith("\n")).toBe(true);
    });

    it("states the phase 11 AI tools", () => {
        expect(md).toContain("| `isolate_voice` | studio | capability | capability `audio.isolate-voice` | runs `ai.run` on the routed provider after pricing it like the editor (OpenNan by default; signed out: the sign-in guidance); the result lands as one undo step |");
        expect(md).toContain("| `stabilize_clip` | studio | capability | capability `media.stabilize` | runs `ai.run` on the desktop app's on-device stabilizer; headless and web: unavailable |");
        expect(md).toContain("| `transcribe_audio` | opennan | capability | capability `audio.transcribe` | runs `ai.run` with engine local (desktop whisper.cpp) or cloud (OpenNan, priced first), else unavailable |");
        expect(md).toContain("| `estimate_cost` | opennan | capability | capability `provider.estimate` | plans the run like the editor and asks the routed provider's `price()`; local tools answer free |");
        expect(md).toContain("| `check_generation_status` | opennan | capability | capability `provider.jobs` | the host's AI job book: status, progress, cost, refund, and whether cancel still stops a job |");
        expect(md).toContain("| `list_voices` | opennan | capability | capability `audio.tts` | the routed speech provider's `voices()`, else unavailable |");
        expect(md).toContain("| `remove_silences` | studio | command | `analysis.run`, `cuts.apply`, `snapshot()` | offline, on the device; needs an audio decoder (editor window, or headless `--ffmpeg`) |");
        expect(md).toContain("| `remove_filler_words` | studio | command | `analysis.fillers`, `cuts.apply`, `snapshot()` | offline; reads the caption word timings |");
        expect(md).toContain("| `auto_cut_to_beat` | studio | command | `beats.autoCut`, `snapshot()` | offline |");
        expect(md.endsWith("\n")).toBe(true);
    });
});

// Round-trip cases for the phase 11 local AI tools: the fixture's stand-in analyzer (testing/fixture.ts
// createFakeAnalyzer) finds silences at source seconds 2-3 and 8-9 and a beat every 0.5 s; filler words come from the
// caption word timings. Each case checks the timeline through the controller and that undo_last_edit takes the edit
// back in one step.
import type { FixtureStudio } from "../fixture";
import { clipOf, data, scenesOf, text, type Case } from "../roundtrip";

const audioClips = (studio: FixtureStudio) => studio.controller.snapshot().clips
    .filter((c) => c.trackType === "audio")
    .map((c) => [c.startTime, c.endTime, c.trimStart ?? 0])
    .sort((a, b) => a[0] - b[0]);

export const ANALYSIS_CASES: Record<string, Case> = {
    remove_silences: async (call, studio) => {
        const preview = data(await call("remove_silences", { clip_id: "music", apply: false }));
        expect(preview).toMatchObject({ ok: true, applied: false, ranges: [{ start: 2, end: 3 }, { start: 8, end: 9 }] });
        expect(clipOf(studio, "music")).toMatchObject({ startTime: 0, endTime: 15 });

        const cut = await call("remove_silences", { clip_id: "music", threshold_db: -45, min_silence: 0.3, padding: 0.05 });
        expect(text(cut)).toBe("Cut 2 silences (2 s) and closed the gaps; later items moved left. undo_last_edit restores them in one step.");
        expect(data(cut)).toMatchObject({ applied: true, removedSeconds: 2 });
        expect(data(cut).createdClipIds).toHaveLength(2);
        expect(audioClips(studio)).toEqual([[0, 2, 0], [2, 7, 3], [7, 13, 9]]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(audioClips(studio)).toEqual([[0, 15, 0]]);

        // A main-track clip (scene 1, 0-4 s) has one silence inside it.
        expect(data(await call("remove_silences", { scene_id: "s1" }))).toMatchObject({ applied: true, ranges: [{ start: 2, end: 3 }], removedSeconds: 1 });
        expect(data(await call("remove_silences", {})).error).toBe("remove_silences needs clip_id or scene_id (one of them).");
        expect(data(await call("remove_silences", { clip_id: "music", scene_id: "s1" })).error).toBe("remove_silences needs clip_id or scene_id (one of them).");
        expect(data(await call("remove_silences", { clip_id: "title" })).error).toMatch(/^remove_silences: /);
    },
    remove_filler_words: async (call, studio) => {
        // Without word timings there is nothing to read.
        expect(data(await call("remove_filler_words", { clip_id: "music" })).error).toMatch(/Add captions with word timings first \(auto_captions\)\.$/);
        await studio.controller.execute({
            type: "clip.update", clipIds: ["title"],
            patch: { captionWordsJson: JSON.stringify([{ text: "So", start: 0, end: 0.4 }, { text: "um", start: 0.5, end: 0.9 }, { text: "hello", start: 1, end: 1.5 }]) },
        });
        const preview = data(await call("remove_filler_words", { clip_id: "music", apply: false }));
        expect(preview).toMatchObject({ applied: false, words: ["um"], language: "en", ranges: [{ start: 0.45, end: 0.95 }] });
        const cut = data(await call("remove_filler_words", { clip_id: "music", language: "en" }));
        expect(cut).toMatchObject({ applied: true, removedSeconds: 0.5, linkedClipIds: ["title"] });
        expect(audioClips(studio)).toEqual([[0, 0.45, 0], [0.45, 14.5, 0.95]]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(audioClips(studio)).toEqual([[0, 15, 0]]);
    },
    detect_beats: async (call, studio) => {
        const found = await call("detect_beats", { clip_id: "music" });
        expect(data(found)).toMatchObject({ ok: true, clipId: "music", bpm: 120, saved: true });
        expect(data(found).beats).toHaveLength(30);
        expect(text(found)).toMatch(/^Found 30 beats at about 120 BPM in clip music \(timeline s: 0, 0\.5, 1,/);
        expect(JSON.parse(clipOf(studio, "music")?.beatsJson ?? "[]")).toHaveLength(30);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "music")?.beatsJson ?? null).toBeNull();
        expect(data(await call("detect_beats", { clip_id: "title" })).error).toBe("Clip title is a text clip; beats are found on audio clips.");
        expect(data(await call("detect_beats", { clip_id: "nope" })).error).toBe("Timeline clip not found: nope");
    },
    auto_cut_to_beat: async (call, studio) => {
        expect(data(await call("auto_cut_to_beat", { scene_ids: ["s1", "s2"], beat_clip_id: "music" })).error).toMatch(/Run detect_beats on the music clip first\.$/);
        await call("detect_beats", { clip_id: "music" });
        const before = scenesOf(studio).map((s) => s.duration);
        const cut = await call("auto_cut_to_beat", { scene_ids: ["s1", "s2", "s3"], beat_clip_id: "music", every: 3 });
        expect(data(cut)).toMatchObject({ ok: true, snapped: 3, unchanged: 0, beatClipId: "music" });
        // Every 3 beats = every 1.5 s: the cuts move from 4 and 10 s to 3 and 9 s, the end from 15 to 13.5 s.
        expect(scenesOf(studio).map((s) => s.duration)).toEqual([3, 6, 4.5]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(scenesOf(studio).map((s) => s.duration)).toEqual(before);
    },
};

// Round-trip cases for the core clip tools.
import type { FixtureStudio } from "../fixture";
import { data, clipOf, type Case } from "../roundtrip";

/** Locks every track of a kind, as the lock button of a track header does. */
async function lockTracks(studio: FixtureStudio, type: string): Promise<void> {
    const tracks = studio.controller.snapshot().tracks.map((t) => (t.type === type ? { ...t, locked: true } : t));
    await studio.controller.execute({ type: "track.update", tracks });
}

export const CLIP_CASES: Record<string, Case> = {
    create_timeline_clip: async (call, studio) => {
        const result = await call("create_timeline_clip", { track_type: "sticker", track_index: 1, start_time: 1, end_time: 2, text_content: "★", position_x: 0.2 });
        expect(result.isError).toBe(false);
        const id = data(result).clipId;
        expect(clipOf(studio, id)).toMatchObject({ trackType: "sticker", startTime: 1, endTime: 2, positionX: 0.2 });
        expect(data(await call("create_timeline_clip", { track_type: "text", track_index: 1, start_time: 3, end_time: 3 })).error)
            .toBe("end_time must be after start_time");
        expect(data(await call("create_timeline_clip", { track_type: "text", track_index: 1, start_time: 1, end_time: 2 })).error)
            .toMatch(/^text1 already has title \(0-3s\) in 1-2s\./);
        await lockTracks(studio, "text");
        expect(data(await call("create_timeline_clip", { track_type: "text", track_index: 1, start_time: 5, end_time: 6 })).error)
            .toBe("Track text1 is locked. Unlock it with manage_timeline_tracks or pick another track.");
    },
    edit_timeline_clip: async (call, studio) => {
        const result = await call("edit_timeline_clip", { clip_id: "title", opacity: 0.5, font_size: 64, bold: true, font_color: "#ff0000" });
        expect(result.isError).toBe(false);
        expect(clipOf(studio, "title")?.opacity).toBe(0.5);
        expect(JSON.parse(clipOf(studio, "title")?.textStyle ?? "{}")).toEqual({ fontSize: 64, fontWeight: "bold", color: "#ff0000" });
        await call("edit_timeline_clip", { clip_id: "music", trim_start: 2 });
        expect(clipOf(studio, "music")).toMatchObject({ trimStart: 2, startTime: 0, endTime: 13 });
        expect((await call("edit_timeline_clip", { clip_id: "music", trim_start: 20 })).isError).toBe(true);
        expect(data(await call("edit_timeline_clip", { clip_id: "missing", opacity: 1 })).error).toBe("Timeline clip not found: missing");
        expect(data(await call("edit_timeline_clip", { clip_id: "music", track_type: "text", track_index: 1, start_time: 0, end_time: 2 })).error)
            .toMatch(/^text1 already has title/);
        await studio.controller.execute({ type: "clip.update", clipIds: ["title"], patch: { locked: true } });
        expect(data(await call("edit_timeline_clip", { clip_id: "title", opacity: 1 })).error).toMatch(/^Clip title is locked\./);
        expect((await call("edit_timeline_clip", { clip_id: "title", locked: false })).isError).toBe(false);
        expect(clipOf(studio, "title")?.locked).toBe(false);
    },
    delete_timeline_clip: async (call, studio) => {
        expect((await call("delete_timeline_clip", { clip_id: "title" })).isError).toBe(false);
        expect(clipOf(studio, "title")).toBeUndefined();
        await lockTracks(studio, "audio");
        expect(data(await call("delete_timeline_clip", { clip_id: "music" })).error)
            .toBe("Clip music is on locked track audio1. Unlock the track with manage_timeline_tracks first.");
        expect(clipOf(studio, "music")).toBeDefined();
    },
    split_timeline_clip: async (call, studio) => {
        const result = await call("split_timeline_clip", { clip_id: "music", at_time: 6 });
        expect(result.isError).toBe(false);
        const right = clipOf(studio, data(result).newClipId);
        expect(right).toMatchObject({ startTime: 6, endTime: 15 });
        expect(clipOf(studio, "music")?.endTime).toBe(6);
        expect((await call("split_timeline_clip", { clip_id: "title", at_time: 9 })).isError).toBe(true);
    },
    add_text_overlay: async (call, studio) => {
        const result = await call("add_text_overlay", { text: "Subscribe", start_time: 4, end_time: 6, position: "bottom", font_size: 40 });
        const created = clipOf(studio, data(result).clipId);
        expect(created).toMatchObject({ trackType: "text", trackIndex: 1, textContent: "Subscribe", positionY: 0.88 });
        expect(JSON.parse(created?.textStyle ?? "{}")).toEqual({ fontSize: 40 });
        // T1 holds the Title clip at 0-3 s, so an overlapping overlay lands on T2.
        const busy = await call("add_text_overlay", { text: "Hi", start_time: 1, end_time: 2 });
        expect(clipOf(studio, data(busy).clipId)).toMatchObject({ trackType: "text", trackIndex: 2 });
    },
    add_audio_layer: async (call, studio) => {
        const result = await call("add_audio_layer", { scene_order: 2, type: "voiceover", url: "https://media.test/vo.mp3", offset: 1 });
        expect(clipOf(studio, data(result).clipId)).toMatchObject({ trackType: "audio", trackIndex: 2, startTime: 5, endTime: 10, sceneId: "s2", label: "voiceover" });
    },
};

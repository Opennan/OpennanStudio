// Round-trip cases for the read tools.
import { data, text, PNG, type Case } from "../roundtrip";

export const READ_CASES: Record<string, Case> = {
    read_timeline: async (call) => {
        const all = await call("read_timeline");
        expect(all.isError).toBe(false);
        expect(text(all)).toContain("Scenes (3):");
        expect(data(all).scenes.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
        expect(data(all).clips[0].mediaUrl).toBeUndefined();
        const one = await call("read_timeline", { scene_order: 2, include_media_urls: true });
        expect(data(one).scenes).toHaveLength(1);
        expect(data(one).scenes[0].shots.map((s: { prompt: string }) => s.prompt)).toEqual(["wide", "close"]);
        expect(data(one).clips.map((c: { id: string }) => c.id)).toEqual(["music"]);
        expect(data(one).clips[0].mediaUrl).toBe("https://media.test/music.mp3");
    },
    find_clip: async (call) => {
        expect(data(await call("find_clip", { text_contains: "hell" })).clipIds).toEqual(["title"]);
        expect(data(await call("find_clip", { track_type: "audio", start_time: 10 })).clipIds).toEqual(["music"]);
        expect(text(await call("find_clip", { label: "nope" }))).toBe("No clips match.");
    },
    client_get_ui_state: async (call) => {
        const ui = data(await call("client_get_ui_state"));
        expect(ui).toMatchObject({ currentTime: 0, isPlaying: false, toolMode: "select", activePanel: null });
    },
    preview_timeline_frame: async (call) => {
        const result = await call("preview_timeline_frame", { time_seconds: 5 });
        expect(result.isError).toBe(false);
        expect(data(result)).toMatchObject({ seconds: 5, rendered: true });
        expect(data(result).visible.scenes.map((s: { id: string }) => s.id)).toEqual(["s2"]);
        expect(data(result).visible.clips.map((c: { id: string }) => c.id)).toEqual(["music"]);
        expect(result.content[1]).toEqual({ type: "image", data: Buffer.from(PNG.data).toString("base64"), mimeType: "image/png" });
    },
    list_media: async (call) => {
        const all = data(await call("list_media"));
        expect(all.media.map((m: { url: string }) => m.url)).toEqual([
            "https://media.test/music.mp3", "https://media.test/a.mp4", "https://media.test/end.png",
        ]);
        expect(data(await call("list_media", { media_type: "image" })).media).toHaveLength(1);
    },
    archive_project: async (call) => {
        expect(data(await call("archive_project")).counts).toEqual({ scenes: 3, clips: 2, media: 3 });
    },
    list_visual_effects: async (call) => {
        // The 20 built-in effects, then the host catalog's own.
        const ids = data(await call("list_visual_effects")).effects.map((e: { id: string }) => e.id);
        expect(ids).toHaveLength(21);
        expect(ids.slice(0, 2)).toEqual(["fx_blur", "fx_zoom_blur"]);
        expect(ids[20]).toBe("blur");
    },
};

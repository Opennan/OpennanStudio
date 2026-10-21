import type { SceneData } from "@opennan/timeline-core";
import {
    CLIP_COLUMNS, IMPLICIT_BASE, POSITION, assignPositions, columnsOf, decodeDoc, decodeScene, encodeClip, encodeDoc, encodeScene, encodeValue, entityId,
    entityKind, extrasJson, ingestDocument, normalizedProject, parseExtrasJson, type Fields, type ServerDoc, type UrlMap,
} from "./codec";
import { baseClip, FIXTURE_IDS, richProject } from "./fixtures";

const LOCAL = "opennan-local://media/aaaaaaaa-1111-4222-8333-444444444444";
const REMOTE = "https://cdn.opennan.com/uploads/media/0123456789abcdef01234567/" + "a".repeat(64) + ".mp4";

export const urls: UrlMap = {
    isCloudUrl: (url) => url.startsWith("https://cdn.opennan.com/") && !url.includes("/uploads/temp/"),
    toRemote: (url) => (url === LOCAL ? REMOTE : undefined),
    toLocal: (url) => (url === REMOTE ? LOCAL : undefined),
};

/** Server defaults of every column a row may be missing (the document's clip, scene and project views). */
const CLIP_DEFAULTS: Record<string, unknown> = {
    media_url: null, media_type: "uploaded", scene_id: null, label: null, thumbnail_url: null, locked: false, volume: 1, audio_pan: 0, audio_pitch: 0, audio_eq: "none",
    audio_denoise: false, audio_normalize: false, playback_speed: 1, speed_ramp: "none", reverse_playback: false, freeze_frame: false, fade_in_duration: 0,
    fade_out_duration: 0, transition_type: "none", transition_duration: 0, opacity: 1, scale: 1, position_x: 0.5, position_y: 0.5, horizontal_flip: false,
    vertical_flip: false, crop_left: 0, crop_right: 0, crop_top: 0, crop_bottom: 0, brightness: 0, contrast: 1, saturation: 1, visual_filter: "none", motion_preset: "none",
    blur_strength: 0, chroma_key_enabled: false, chroma_key_color: "0x00FF00", chroma_key_similarity: 0.1, chroma_key_blend: 0, blend_mode: "normal", mosaic_strength: 0,
    rotation_degrees: 0, keyframes_json: null, text_content: null, text_style: null, trim_start: null, trim_end: null, remotion_template_id: null, remotion_props_json: null,
    transition_params_json: null, custom_graphic_id: null, effects: [],
};
const SCENE_DEFAULTS: Record<string, unknown> = {
    order: 0, caption: "", card_type: "ai_video", status: "pending", duration: 5, timeline_position_seconds: 0, track_index: 1, transition: null, visual_transition: "none",
    visual_transition_duration: 0, scene_location: null, objects_in_scene: [], overlay_text: null, audio_text: null, music_enabled: false, start_image_url: null,
    end_image_url: null, video_url: null, audio_url: null, source_video_url: null, background_url: null, shots: [], start_time: "00:00:00,000", end_time: "00:00:05,000",
    card_config: null, fit_mode: null, transform_scale: null, transform_offset_x: null, transform_offset_y: null, source_width: null, source_height: null, effects: [],
};
const PROJECT_DEFAULTS: Record<string, unknown> = { name: "Untitled", description: null, aspect_ratio: "16:9", music_url: null, music_filename: null, music_volume: 1, default_audio_on: false };

/** What a server holding these entities answers on GET …/document: every column, defaults filled, extras_json as sent. */
export async function serverDocument(doc: ServerDoc, revision = 1) {
    const rows = { clips: [] as Array<Record<string, unknown>>, scenes: [] as Array<Record<string, unknown>>, tracks: [] as Array<Record<string, unknown>>, project: {} as Record<string, unknown> };
    for (const [key, fields] of Object.entries(doc.entities)) {
        const kind = entityKind(key);
        const extras = await extrasJson(fields);
        if (kind === "project") rows.project = { ...PROJECT_DEFAULTS, ...columnsOf(fields), extras_json: extras };
        else if (kind === "track") {
            const [type, index] = entityId(key).split(":");
            rows.tracks.push({ type, index: Number(index), label: `${type![0]!.toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1, ...columnsOf(fields) });
        } else if (kind === "clip") rows.clips.push({ ...CLIP_DEFAULTS, ...columnsOf(fields), id: entityId(key), extras_json: extras });
        else rows.scenes.push({ ...SCENE_DEFAULTS, ...columnsOf(fields), id: entityId(key), extras_json: extras });
    }
    // The server lists scenes by its own order and clips in its own order: neither is Studio's.
    rows.scenes.reverse().forEach((scene, i) => (scene.order = i));
    rows.clips.reverse();
    return { revision, project: rows.project, tracks: rows.tracks, clips: rows.clips, scenes: rows.scenes, media: [] };
}

describe("codec", () => {
    it("round-trips a 10d/11-era project through the server byte for byte", async () => {
        const local = richProject(LOCAL);
        const encoded = encodeDoc(local, { urls });
        const confirmed = await ingestDocument(await serverDocument(encoded));
        const decoded = decodeDoc(confirmed, "local-project", urls);
        expect(normalizedProject(decoded)).toBe(normalizedProject(local));
        // Another device: no local copy of the media, so it sees the uploaded URL.
        const elsewhere = decodeDoc(confirmed, "cloud-x", { ...urls, toLocal: () => undefined });
        expect(elsewhere.clips.find((c) => c.id === FIXTURE_IDS.clipVideo)!.mediaUrl).toBe(REMOTE);
        expect(normalizedProject(decodeDoc(confirmed, "cloud-x", { ...urls, toLocal: () => undefined })).replaceAll(REMOTE, LOCAL)).toBe(normalizedProject(local));
    });

    it("re-encodes a decoded document to the same fields (no edit, no changes)", async () => {
        const local = richProject(LOCAL);
        const confirmed = await ingestDocument(await serverDocument(encodeDoc(local, { urls })));
        const again = encodeDoc(decodeDoc(confirmed, "p", urls), { urls, confirmed });
        for (const [key, fields] of Object.entries(again.entities)) {
            for (const [name, value] of Object.entries(fields)) expect([key, name, confirmed.entities[key]?.[name]]).toEqual([key, name, value]);
        }
    });

    it("sends what a column can hold and keeps the exact value in extras", () => {
        const fields = encodeClip(baseClip(FIXTURE_IDS.clipVideo, { volume: 5, playbackSpeed: 100, scale: 0, label: "x".repeat(300) }), urls);
        expect(fields.volume).toBe(4);
        expect(fields["x.$x.volume"]).toBe(5);
        expect(fields.playback_speed).toBe(100);
        expect(fields["x.$x.playback_speed"]).toBeUndefined();
        expect("scale" in fields).toBe(false);
        expect(fields["x.$x.scale"]).toBe(0);
        expect("label" in fields).toBe(false);
        expect(fields["x.$x.label"]).toBe("x".repeat(300));
        expect(fields["x.$u.transition_params_json"]).toBe(true);
    });

    it("lets a later server value win over a stale exact value", async () => {
        const local = richProject(LOCAL);
        const encoded = encodeDoc(local, { urls });
        const document = await serverDocument(encoded);
        const clip = document.clips.find((c) => c.id === FIXTURE_IDS.clipVideo)!;
        clip.volume = 2; // edited on opennan.com: no longer the 4 Studio sent for its 5
        const decoded = decodeDoc(await ingestDocument(document), "p", urls);
        expect(decoded.clips.find((c) => c.id === FIXTURE_IDS.clipVideo)!.volume).toBe(2);
    });

    it("leaves unuploaded local media in server space, and uploaded media as its URL", () => {
        const other = "opennan-local://media/bbbbbbbb-1111-4222-8333-444444444444";
        expect(encodeClip(baseClip(FIXTURE_IDS.clipVideo, { mediaUrl: other }), urls).media_url).toBe(other);
        expect(encodeClip(baseClip(FIXTURE_IDS.clipVideo, { mediaUrl: LOCAL }), urls).media_url).toBe(REMOTE);
        const foreign = encodeClip(baseClip(FIXTURE_IDS.clipVideo, { mediaUrl: "https://example.com/a.mp4" }), urls);
        expect("media_url" in foreign).toBe(false);
        expect(foreign["x.$x.media_url"]).toBe("https://example.com/a.mp4");
        expect(encodeValue(CLIP_COLUMNS.find((c) => c.col === "media_url")!, "https://cdn.opennan.com/uploads/temp/x/y.mp4", urls)).not.toBe("https://cdn.opennan.com/uploads/temp/x/y.mp4");
    });

    it("keeps scene fields the server shows out of extras while Studio's value is the server's", () => {
        const confirmed = { ...SCENE_DEFAULTS, status: "video_ready", transition: null, shots: [{ index: 0, description: "wide", duration: 2 }], order: 3 } as Fields;
        const scene = decodeScene("s1", confirmed, urls);
        expect(scene.status).toBe("video_ready");
        expect(JSON.parse(scene.shotBreakdown!)[0]).toMatchObject({ prompt: "wide", duration: 2, readOnly: true });
        const fields = encodeScene(scene, urls, confirmed);
        expect(Object.keys(fields).filter((k) => k.startsWith("x."))).toEqual([]);
        const edited = encodeScene({ ...scene, status: "planned" } as SceneData, urls, confirmed);
        expect(edited["x.status"]).toBe("planned");
    });

    it("decodes a scene's storyboard sheets (phase 9c) read only: camelCase, cached files as local URLs, never written back", () => {
        const sheet = `${REMOTE.replace(".mp4", ".png")}`;
        const confirmed = {
            ...SCENE_DEFAULTS, shots_version: "sv_0123456789abcdef01234567",
            storyboard_sheets: [{ image_url: sheet, panels: [{ index: 0, shot_index: 0, image_url: REMOTE }, { index: 1, shot_index: 1, image_url: "javascript:x" }, { nope: true }] }, { image_url: null, panels: [] }],
        } as unknown as Fields;
        const scene = decodeScene("s1", confirmed, urls);
        expect(scene.storyboardSheets).toEqual([{ imageUrl: sheet, panels: [{ index: 0, shotIndex: 0, imageUrl: LOCAL }] }, { imageUrl: null, panels: [] }]);
        expect(Object.keys(encodeScene(scene, urls, confirmed)).filter((k) => k.startsWith("x."))).toEqual([]);
        // Even a working copy that differs from the server never pins sheets into extras (only the server draws them).
        expect(encodeScene({ ...scene, storyboardSheets: [] }, urls, confirmed)["x.storyboardSheets"]).toBeUndefined();
        // No sheets: the field is left out.
        expect(decodeScene("s2", SCENE_DEFAULTS as Fields, urls).storyboardSheets).toBeUndefined();
    });

    it("takes storyboard sheet and panel images only from OpenNan's storage (or this device), and reports the others (9c.1)", () => {
        const ignored: string[] = [];
        const reporting: UrlMap = { ...urls, ignored: (url) => void ignored.push(url) };
        const sheet = "https://cdn.opennan.com/results/s1/sheet.png";
        const confirmed = {
            ...SCENE_DEFAULTS,
            storyboard_sheets: [
                { image_url: "https://evil.example/sheet.png", panels: [{ index: 0, shot_index: 0, image_url: "https://evil.example/p0.png" }, { index: 1, shot_index: 1, image_url: sheet }] },
                { image_url: sheet, panels: [{ index: 2, shot_index: 2, image_url: "https://cdn.opennan.com/uploads/temp/x/p.png" }, { index: 3, shot_index: 3, image_url: LOCAL }, { index: 4, shot_index: 4, image_url: "https://cdn.opennan.com.evil.example/p.png" }] },
            ],
            shots: [{ index: 0, description: "wide", duration: 2, image_url: "https://evil.example/k.png", end_image_url: sheet, video_url: "https://evil.example/v.mp4" }, { index: 1, description: "close", duration: 2, video_url: "https://cdn.opennan.com/results/s1/v.mp4" }],
        } as unknown as Fields;
        const scene = decodeScene("s1", confirmed, reporting);
        expect(scene.storyboardSheets).toEqual([
            { imageUrl: null, panels: [{ index: 1, shotIndex: 1, imageUrl: sheet }] },
            { imageUrl: sheet, panels: [{ index: 3, shotIndex: 3, imageUrl: LOCAL }] },
        ]);
        // The shots' keyframes are the panels of a scene without sheets: the same rule.
        const shot = JSON.parse(scene.shotBreakdown!)[0];
        expect(shot.keyframe_url).toBeUndefined();
        expect(shot.end_keyframe_url).toBe(sheet);
        // A shot's video too (review 9c.1).
        expect(shot.video_url).toBeUndefined();
        expect(JSON.parse(scene.shotBreakdown!)[1].video_url).toBe("https://cdn.opennan.com/results/s1/v.mp4");
        expect([...new Set(ignored)].sort()).toEqual(["https://cdn.opennan.com.evil.example/p.png", "https://cdn.opennan.com/uploads/temp/x/p.png", "https://evil.example/k.png", "https://evil.example/p0.png", "https://evil.example/sheet.png", "https://evil.example/v.mp4"]);
        // Nothing of it is ever written back.
        expect(Object.keys(encodeScene(scene, reporting, confirmed)).filter((k) => k.startsWith("x."))).toEqual([]);
    });

    it("a scene's shots from OpenNan win over Studio's own breakdown kept in extras, which is never pinned over them", () => {
        const drawn = { ...SCENE_DEFAULTS, shots: [{ index: 0, description: "wide", duration: 2, image_url: REMOTE }], "x.shotBreakdown": "[]" } as Fields;
        const scene = decodeScene("s1", drawn, urls);
        expect(JSON.parse(scene.shotBreakdown!)).toHaveLength(1);
        const fields = encodeScene({ ...scene, shotBreakdown: "[]" }, urls, drawn);
        expect(fields["x.shotBreakdown"]).toBeUndefined();
        // Without shots from OpenNan, Studio's own breakdown is what the scene shows.
        expect(decodeScene("s2", { ...SCENE_DEFAULTS, "x.shotBreakdown": JSON.stringify([{ duration: 2, prompt: "mine" }]) } as Fields, urls).shotBreakdown).toContain("mine");
    });

    it("compresses large extras and reads them back", async () => {
        const words = Array.from({ length: 4000 }, (_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.25, text: `word${i}` }));
        const fields = encodeClip(baseClip(FIXTURE_IDS.clipText, { trackType: "text", captionWordsJson: JSON.stringify(words) }), urls);
        const text = (await extrasJson(fields))!;
        expect(text.startsWith('{"$z":')).toBe(true);
        expect(new TextEncoder().encode(text).length).toBeLessThan(64 * 1024);
        expect((await parseExtrasJson(text))!.captionWordsJson).toBe(JSON.stringify(words));
    });

    it("assigns list positions that move only what moved", () => {
        const previous = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
        const moved = assignPositions(["a", "c", "b", "d"], (id) => previous.get(id));
        expect([...moved.entries()].filter(([id, p]) => p !== previous.get(id)).length).toBe(1);
        const order = ["a", "c", "b", "d"].sort((x, y) => (moved.get(x) as number) - (moved.get(y) as number));
        expect(order).toEqual(["a", "c", "b", "d"]);
        const inserted = assignPositions(["a", "new", "b"], (id) => previous.get(id));
        expect(inserted.get("new")).toBeGreaterThan(0);
        expect(inserted.get("new")).toBeLessThan(1);
        // Entities made on opennan.com have implicit positions that are kept, never written.
        const implicit = assignPositions(["w1", "w2"], (id) => (id === "w1" ? IMPLICIT_BASE : IMPLICIT_BASE + 1));
        expect([...implicit.values()]).toEqual([null, null]);
        // A new entity between two of them can't get an implicit position: everything is renumbered.
        const between = assignPositions(["w1", "n", "w2"], (id) => (id === "w1" ? IMPLICIT_BASE : id === "w2" ? IMPLICIT_BASE + 1 : undefined));
        expect([...between.values()]).toEqual([0, 1, 2]);
    });

    it("keeps clip order through the server and another encode", async () => {
        const local = richProject(LOCAL);
        local.clips.reverse();
        const encoded = encodeDoc(local, { urls });
        const confirmed = await ingestDocument(await serverDocument(encoded));
        expect(decodeDoc(confirmed, "p", urls).clips.map((c) => c.id)).toEqual(local.clips.map((c) => c.id));
        expect(Object.values(encoded.entities).filter((f) => POSITION in f).length).toBe(local.clips.length + local.scenes.length);
    });

    it("keeps Studio's exact value through the server's own normalisations", async () => {
        const local = richProject(LOCAL);
        local.scenes[1]!.duration = 4; // cardType null: the server takes it as ai_video and rounds a patched length to 5
        local.clips[1]!.transitionType = "none";
        local.clips[1]!.transitionDuration = 0.3; // the server shows 0 for no transition
        const encoded = encodeDoc(local, { urls });
        expect(encoded.entities[`scene:${FIXTURE_IDS.sceneB}`]!["x.$x.duration"]).toBe(4);
        const document = await serverDocument(encoded);
        document.scenes.find((s) => s.id === FIXTURE_IDS.sceneB)!.duration = 5;
        document.clips.find((c) => c.id === FIXTURE_IDS.clipText)!.transition_duration = 0;
        const decoded = decodeDoc(await ingestDocument(document), "p", urls);
        expect(normalizedProject(decoded)).toBe(normalizedProject(local));
        // An edit on opennan.com to another length still wins.
        document.scenes.find((s) => s.id === FIXTURE_IDS.sceneB)!.duration = 15;
        expect(decodeDoc(await ingestDocument(document), "p", urls).scenes[1]!.duration).toBe(15);
    });

    it("encodes and diffs a 5,000-clip project fast enough to run on every write", async () => {
        const { diffDocs } = await import("./delta");
        const local = richProject(LOCAL);
        local.clips = Array.from({ length: 5000 }, (_, i) => baseClip(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { startTime: i, endTime: i + 1, maskJson: '{"kind":"circle"}' }));
        const before = encodeDoc(local, { urls });
        local.clips[100]!.opacity = 0.5;
        const started = performance.now();
        const after = encodeDoc(local, { urls, previous: before });
        const delta = diffDocs(before, after);
        const elapsed = performance.now() - started;
        expect(Object.keys(delta.entities)).toEqual(["clip:00000000-0000-4000-8000-000000000100"]);
        // ~50 ms on an M2 Pro when idle; generous for a loaded machine.
        expect(elapsed).toBeLessThan(1500);
    });
});

// The fake OpenNan server's cloud project routes (phase 9a): projects, import, the document (ETag / 304), atomic
// changesets (Idempotency-Key, If-Match, refusals with details, normalisation), trash, uploads v2 through the
// gateway, storage, and the /__test/cloud knobs. The fake is Studio's contract with opennan.com: each test pins one
// rule transcribed from the server's routers.
import { createHash } from "node:crypto";
import { startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
let key: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => {
    fake.reset();
    key = fake.mintKey();
});

interface ErrorBody { type?: string; code?: string; message?: string; details?: Record<string, unknown> }
interface Answer { status: number; body: Record<string, any> & { error?: ErrorBody }; headers: Headers }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const response = await fetch(fake.url + path, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

let serial = 0;
const change = (projectId: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", `/v1/projects/${projectId}/changes`, body, { "idempotency-key": `k-${++serial}`, ...headers });
const knob = (name: string, body: unknown = {}) => fetch(`${fake.url}/__test/cloud/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const cloudState = () => fetch(`${fake.url}/__test/cloud/state`).then((r) => r.json());
const uuid = () => crypto.randomUUID();
const files = (name: string) => `${fake.url}/files/results/${name}`;

async function project(name = "Film"): Promise<string> {
    const created = await call("POST", "/v1/projects", { name });
    expect(created.status).toBe(201);
    return created.body.id as string;
}

async function document(projectId: string): Promise<Answer> {
    return call("GET", `/v1/projects/${projectId}/document`);
}

const clip = (fields: Record<string, unknown> = {}) => ({ id: uuid(), track_type: "video", track_index: 1, start_time: 0, end_time: 2, ...fields });

describe("projects", () => {
    it("creates a project (201) with the server's ProjectView defaults", async () => {
        const created = await call("POST", "/v1/projects", { name: "Film" });
        expect(created.status).toBe(201);
        expect(Object.keys(created.body)).toEqual([
            "object", "id", "name", "description", "product_type", "status", "aspect_ratio", "visual_style", "camera_type", "default_video_quality",
            "default_audio_on", "music_url", "music_filename", "music_volume", "final_video_url", "scene_count", "timeline_revision", "created_at",
            "updated_at", "duration_seconds", "thumbnail_url", "media_bytes", "data_bytes", "origin", "last_edited_device", "deleted_at",
        ]);
        expect(created.body).toMatchObject({
            object: "project", name: "Film", description: null, product_type: "music_video", status: "draft", aspect_ratio: "16:9", visual_style: "cinema",
            camera_type: "cinema-35mm", default_video_quality: "480p", default_audio_on: false, music_volume: 1, scene_count: 0, timeline_revision: 0,
            origin: "web", last_edited_device: null, deleted_at: null, duration_seconds: 0, media_bytes: 0,
        });
        expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("makes one scene per SRT cue", async () => {
        const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n";
        const created = await call("POST", "/v1/projects", { name: "Lyrics", srt_content: srt });
        expect(created.body.scene_count).toBe(2);
        const doc = await document(created.body.id);
        expect(doc.body.scenes.map((s: Record<string, unknown>) => [s.order, s.caption, s.start_time, s.end_time])).toEqual([[0, "Hello", "00:00:01,000", "00:00:02,500"], [1, "World", "00:00:03,000", "00:00:04,000"]]);
    });

    it.each([
        [{ name: "" }],
        [{ name: "x".repeat(256) }],
        [{ name: "Film", extra: 1 }],
        [{ name: "Film", aspect_ratio: "2:1" }],
        [{ name: "Film", music_url: "https://elsewhere.example/a.mp3" }],
        [{ name: "Film", product_type: "opera" }],
        [{}],
    ])("refuses the create body %j", async (body) => {
        const answer = await call("POST", "/v1/projects", body);
        expect(answer.status).toBe(400);
        expect(answer.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_request" });
    });

    it("needs a key (401) with scope api:project (403)", async () => {
        key = "sk-nope";
        expect((await call("GET", "/v1/projects")).status).toBe(401);
        await fetch(`${fake.url}/__test/key-scopes?scopes=api:voice`);
        key = fake.mintKey();
        const refused = await call("GET", "/v1/projects");
        expect(refused.status).toBe(403);
        expect(refused.body.error).toMatchObject({ type: "permission_error", code: "permission_denied" });
        expect((await call("GET", "/v1/storage")).status).toBe(403);
        expect((await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: 4 })).status).toBe(403);
    });

    it("reads, patches (If-Match, ETag) and refuses nulls the server refuses", async () => {
        const id = await project();
        expect((await call("GET", `/v1/projects/${id}`)).body.name).toBe("Film");
        expect((await call("GET", "/v1/projects/nope")).status).toBe(404);
        const patched = await call("PATCH", `/v1/projects/${id}`, { name: "Renamed", music_volume: 1.5, description: "d" }, { "if-match": '"r0"' });
        expect(patched.status).toBe(200);
        expect(patched.headers.get("etag")).toBe('"r0"');
        expect(patched.body).toMatchObject({ name: "Renamed", music_volume: 1.5, description: "d", timeline_revision: 0 });
        expect((await call("PATCH", `/v1/projects/${id}`, { description: null })).body.description).toBeNull();
        const nulled = await call("PATCH", `/v1/projects/${id}`, { name: null });
        expect(nulled.status).toBe(400);
        expect(nulled.body.error?.message).toBe("Value error, name can't be null");
        await change(id, { clips: { create: [clip()] } });
        const stale = await call("PATCH", `/v1/projects/${id}`, { name: "Old" }, { "if-match": "0" });
        expect(stale.status).toBe(412);
        expect(stale.body.error).toMatchObject({ type: "precondition_failed", code: "timeline_changed", details: { revision: 1 } });
        expect((await call("PATCH", `/v1/projects/${id}`, { name: "x" }, { "if-match": "banana" })).status).toBe(400);
    });

    it("lists newest first, pages by cursor, and keeps the cursor stable while projects are edited", async () => {
        const ids: string[] = [];
        for (const name of ["A", "B", "C", "D", "E"]) ids.push(await project(name));
        const created = await call("GET", "/v1/projects");
        expect(created.body).toMatchObject({ object: "list", has_more: false, next_cursor: null });
        expect(created.body.data.map((p: { name: string }) => p.name)).toEqual(["E", "D", "C", "B", "A"]);
        const first = await call("GET", "/v1/projects?order=updated&limit=2");
        expect(first.body.data.map((p: { name: string }) => p.name)).toEqual(["E", "D"]);
        expect(first.body.has_more).toBe(true);
        expect(first.body.next_cursor).toMatch(/^[A-Za-z0-9_=-]+$/);
        await call("PATCH", `/v1/projects/${ids[1]}`, { name: "B2" }); // B moves to the top of "updated"
        const second = await call("GET", `/v1/projects?order=updated&limit=2&cursor=${first.body.next_cursor}`);
        expect(second.body.data.map((p: { name: string }) => p.name)).toEqual(["C", "A"]);
        expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
        const top = await call("GET", "/v1/projects?order=updated&limit=1");
        expect(top.body.data[0].name).toBe("B2");
        const after = await call("GET", `/v1/projects?limit=2&starting_after=${ids[3]}`);
        expect(after.body.data.map((p: { name: string }) => p.name)).toEqual(["C", "B2"]);
        expect((await call("GET", "/v1/projects?cursor=!!")).status).toBe(400);
        expect((await call("GET", "/v1/projects?cursor=bm9wZQ")).status).toBe(400);
        expect((await call("GET", "/v1/projects?limit=101")).status).toBe(400);
        expect((await call("GET", "/v1/projects?limit=0")).status).toBe(400);
        expect((await call("GET", "/v1/projects?order=name")).status).toBe(400);
    });

    it("moves to the trash, restores, and deletes permanently", async () => {
        const kept = await project("Kept");
        const id = await project("Gone");
        expect((await call("DELETE", `/v1/projects/${id}`)).body).toEqual({ id, object: "project", deleted: true });
        expect((await call("GET", `/v1/projects/${id}`)).status).toBe(404);
        expect((await document(id)).status).toBe(404);
        expect((await change(id, { label: "x" })).status).toBe(404);
        expect((await call("GET", "/v1/projects")).body.data.map((p: { id: string }) => p.id)).toEqual([kept]);
        const trash = await call("GET", "/v1/projects?state=deleted");
        expect(trash.body.data).toHaveLength(1);
        expect(trash.body.data[0]).toMatchObject({ id, deleted_at: expect.stringMatching(/Z$/) });
        expect((await call("POST", `/v1/projects/${kept}/restore`)).status).toBe(404);
        const restored = await call("POST", `/v1/projects/${id}/restore`);
        expect(restored.status).toBe(200);
        expect(restored.body).toMatchObject({ id, deleted_at: null });
        await call("DELETE", `/v1/projects/${id}`);
        expect((await call("DELETE", `/v1/projects/${id}?permanent=true`)).body.deleted).toBe(true);
        expect((await call("GET", "/v1/projects?state=deleted")).body.data).toEqual([]);
        expect((await call("POST", `/v1/projects/${id}/restore`)).status).toBe(404);
        expect((await call("DELETE", `/v1/projects/${kept}?permanent=true`)).status).toBe(200);
        expect((await call("GET", "/v1/projects")).body.data).toEqual([]);
        expect((await call("DELETE", `/v1/projects/${kept}`)).status).toBe(404);
    });
});

describe("import", () => {
    it("keeps free lowercase UUIDs, replaces the rest, remaps clip scenes, and maps every id", async () => {
        const kept = uuid();
        const keptClip = uuid();
        const taken = uuid();
        const other = await project("Other");
        await change(other, { scenes: { create: [{ id: taken }] } });
        const body = {
            project: { name: "Imported", aspect_ratio: "9:16", extras_json: '{"fps":30}' },
            scenes: [
                { id: kept, caption: "One", duration: 4, extras_json: '{"look":"warm"}', effects: [{ effect_id: "blur", params_json: '{"r":2}' }] },
                { id: "local-2", caption: "Two" },
                { id: taken, caption: "Three" },
                { id: kept.toUpperCase(), caption: "Four" },
            ],
            timeline: {
                tracks: [{ type: "video", index: 1, label: "Main" }, { type: "audio", index: 1 }],
                clips: [
                    { id: keptClip, track_type: "video", track_index: 1, start_time: 0, end_time: 3, scene_id: "local-2", media_url: files("a.mp4"), effects: [{ effect_id: "glow", order: 1 }] },
                    { id: "c2", track_type: "audio", track_index: 1, start_time: 1, end_time: 2, volume: 3.5, extras_json: '{"beats":[1]}' },
                ],
            },
        };
        const imported = await call("POST", "/v1/projects/import", body);
        expect(imported.status).toBe(201);
        const { project: view, scene_ids: scenes, clip_ids: clips } = imported.body;
        expect(view).toMatchObject({ name: "Imported", aspect_ratio: "9:16", origin: "studio", timeline_revision: 0, scene_count: 4 });
        expect(view).not.toHaveProperty("extras_json");
        expect(scenes[kept]).toBe(kept);
        expect(clips[keptClip]).toBe(keptClip);
        for (const local of ["local-2", taken, kept.toUpperCase()]) {
            expect(scenes[local]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            expect(scenes[local]).not.toBe(local);
        }
        expect(clips.c2).not.toBe("c2");
        const doc = await document(view.id);
        expect(doc.body.project.extras_json).toBe('{"fps":30}');
        expect(doc.body.tracks).toEqual([
            { type: "video", index: 1, label: "Main", muted: false, locked: false, visible: true, volume: 1 },
            { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
        ]);
        const first = doc.body.scenes[0];
        expect(first).toMatchObject({ id: kept, order: 0, caption: "One", duration: 4, start_time: "00:00:00,000", end_time: "00:00:04,000", extras_json: '{"look":"warm"}', effects: [{ effect_id: "blur", order: 0, enabled: true, params_json: '{"r":2}' }], shots: [] });
        expect(doc.body.scenes[1]).toMatchObject({ caption: "Two", duration: 5, end_time: "00:00:05,000", card_type: "ai_video", effects: [] });
        const videoClip = doc.body.clips.find((c: { id: string }) => c.id === keptClip);
        expect(videoClip).toMatchObject({ scene_id: scenes["local-2"], media_url: files("a.mp4"), effects: [{ effect_id: "glow", order: 1, enabled: true, params_json: null }] });
        expect(doc.body.clips.find((c: { id: string }) => c.id === clips.c2)).toMatchObject({ volume: 3.5, extras_json: '{"beats":[1]}' });
        const second = await call("POST", "/v1/projects/import", body);
        expect(second.body.scene_ids[kept]).not.toBe(kept);
        expect(second.body.clip_ids[keptClip]).not.toBe(keptClip);
    });

    it("refuses a clip naming a scene the bundle lacks, duplicate ids, and temp or foreign media", async () => {
        const missing = await call("POST", "/v1/projects/import", { project: { name: "x" }, timeline: { clips: [{ id: "c", track_type: "video", track_index: 1, start_time: 0, end_time: 1, scene_id: "nope" }] } });
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatchObject({ code: "invalid_change", message: "A clip names a scene the bundle does not have" });
        const twice = await call("POST", "/v1/projects/import", { project: { name: "x" }, scenes: [{ id: "a" }, { id: "a" }] });
        expect(twice.status).toBe(400);
        expect(twice.body.error?.code).toBe("invalid_request");
        const temp = await call("POST", "/v1/projects/import", { project: { name: "x" }, scenes: [{ id: "a", video_url: `${fake.url}/files/uploads/temp/x/y.mp4` }] });
        expect(temp.status).toBe(400);
        expect(temp.body.error?.message).toContain("temporary upload");
        const foreign = await call("POST", "/v1/projects/import", { project: { name: "x" }, scenes: [{ id: "a", video_url: "https://cdn.example/y.mp4" }] });
        expect(foreign.status).toBe(400);
        expect((await call("GET", "/v1/projects")).body.data).toEqual([]);
    });
});

describe("document", () => {
    it("answers the whole document with ETag r<revision> and 304 for If-None-Match", async () => {
        const id = await project();
        const doc = await document(id);
        expect(doc.status).toBe(200);
        expect(doc.headers.get("etag")).toBe('"r0"');
        expect(Object.keys(doc.body)).toEqual(["object", "revision", "project", "tracks", "clips", "scenes", "media"]);
        expect(doc.body).toMatchObject({ object: "project_document", revision: 0, clips: [], scenes: [], media: [] });
        expect(doc.body.project).toMatchObject({ id, extras_json: null });
        expect(doc.body.tracks).toEqual([
            { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
        ]);
        const response = await fetch(`${fake.url}/v1/projects/${id}/document`, { headers: { authorization: `Bearer ${key}`, "if-none-match": '"r0"' } });
        expect(response.status).toBe(304);
        expect(response.headers.get("etag")).toBe('"r0"');
        expect(await response.text()).toBe("");
        expect((await call("GET", `/v1/projects/${id}/document`, undefined, { "if-none-match": 'W/"r0"' })).status).toBe(304);
        await change(id, { clips: { create: [clip()] } });
        const fresh = await call("GET", `/v1/projects/${id}/document`, undefined, { "if-none-match": '"r0"' });
        expect(fresh.status).toBe(200);
        expect(fresh.headers.get("etag")).toBe('"r1"');
        const state = await cloudState();
        expect(state).toMatchObject({ document_reads: 2, document_304s: 2 });
    });

    it("shows every ClipView field with its default and every DocumentSceneView field", async () => {
        const id = await project();
        const sceneId = uuid();
        const clipId = uuid();
        await change(id, { scenes: { create: [{ id: sceneId }] }, clips: { create: [{ id: clipId, track_type: "text", track_index: 1, start_time: 1, end_time: 3, text_content: "Hi" }] } });
        const doc = await document(id);
        expect(doc.body.clips[0]).toEqual({
            id: clipId, track_type: "text", track_index: 1, start_time: 1, end_time: 3, media_url: null, media_type: "uploaded", scene_id: null, label: null,
            thumbnail_url: null, locked: false, volume: 1, audio_pan: 0, audio_pitch: 0, audio_eq: "none", audio_denoise: false, audio_normalize: false,
            playback_speed: 1, speed_ramp: "none", reverse_playback: false, freeze_frame: false, fade_in_duration: 0, fade_out_duration: 0,
            transition_type: "none", transition_duration: 0, opacity: 1, scale: 1, position_x: 0.5, position_y: 0.5, horizontal_flip: false,
            vertical_flip: false, crop_left: 0, crop_right: 0, crop_top: 0, crop_bottom: 0, brightness: 0, contrast: 1, saturation: 1,
            visual_filter: "none", motion_preset: "none", blur_strength: 0, chroma_key_enabled: false, chroma_key_color: "0x00FF00",
            chroma_key_similarity: 0.1, chroma_key_blend: 0, blend_mode: "normal", mosaic_strength: 0, rotation_degrees: 0, keyframes_json: null,
            text_content: "Hi", text_style: null, trim_start: null, trim_end: null, remotion_template_id: null, remotion_props_json: null,
            transition_params_json: null, custom_graphic_id: null, extras_json: null, effects: [],
        });
        expect(doc.body.scenes[0]).toEqual({
            object: "scene", id: sceneId, order: 0, caption: "", card_type: "ai_video", status: "pending", duration: 5, timeline_position_seconds: 0,
            track_index: 1, transition: null, visual_transition: "none", visual_transition_duration: 0, scene_location: null, objects_in_scene: [],
            overlay_text: null, audio_text: null, music_enabled: false, start_image_url: null, end_image_url: null, video_url: null, audio_url: null,
            source_video_url: null, background_url: null, shots: [], start_time: "00:00:00,000", end_time: "00:00:05,000", card_config: null,
            fit_mode: null, transform_scale: null, transform_offset_x: null, transform_offset_y: null, source_width: null, source_height: null,
            extras_json: null, effects: [], shots_version: expect.stringMatching(/^sv_[0-9a-f]{24}$/), storyboard_sheets: [],
        });
    });
});

describe("changes", () => {
    it("applies a changeset atomically: one revision, the touched rows, ETag, device", async () => {
        const id = await project();
        const sceneId = uuid();
        const clipId = uuid();
        const answer = await change(id, {
            label: "Add", device: "Ada's Mac",
            scenes: { create: [{ id: sceneId, caption: "Intro", card_config: '{"a":1}', fit_mode: "cover", effects: [{ effect_id: "warm" }] }] },
            clips: { create: [{ id: clipId, track_type: "video", track_index: 1, start_time: 0, end_time: 4, scene_id: sceneId, media_url: files("v.mp4"), playback_speed: 100, extras_json: '{"mask":{}}' }] },
        }, { "if-match": '"r0"' });
        expect(answer.status).toBe(200);
        expect(answer.headers.get("etag")).toBe('"r1"');
        expect(Object.keys(answer.body)).toEqual(["object", "revision", "etag", "clips", "scenes", "tracks", "project", "deleted"]);
        expect(answer.body).toMatchObject({ object: "project_change", revision: 1, etag: '"r1"', tracks: null, project: null, deleted: { clips: [], scenes: [] } });
        expect(answer.body.clips).toEqual([expect.objectContaining({ id: clipId, scene_id: sceneId, playback_speed: 100, extras_json: '{"mask":{}}', effects: [] })]);
        expect(answer.body.scenes).toEqual([expect.objectContaining({ id: sceneId, caption: "Intro", card_config: '{"a":1}', fit_mode: "cover", effects: [{ effect_id: "warm", order: 0, enabled: true, params_json: null }] })]);
        const view = (await call("GET", `/v1/projects/${id}`)).body;
        expect(view).toMatchObject({ timeline_revision: 1, last_edited_device: "Ada's Mac", origin: "studio", duration_seconds: 5 });
        expect(Date.parse(view.updated_at)).toBeGreaterThanOrEqual(Date.parse(view.created_at));
    });

    it("needs an Idempotency-Key of 1 to 64 characters", async () => {
        const id = await project();
        expect((await call("POST", `/v1/projects/${id}/changes`, { label: "x" })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/changes`, { label: "x" }, { "idempotency-key": "k".repeat(65) })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/changes`, { label: "x" }, { "idempotency-key": "k".repeat(64) })).status).toBe(200);
    });

    it("replays a stored answer for the same key and body, and refuses the key with another body", async () => {
        const id = await project();
        const body = { clips: { create: [clip()] } };
        const headers = { "idempotency-key": "same" };
        const first = await call("POST", `/v1/projects/${id}/changes`, body, headers);
        const again = await call("POST", `/v1/projects/${id}/changes`, body, { ...headers, "if-match": "0" });
        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        expect((await document(id)).body.revision).toBe(1);
        const reused = await call("POST", `/v1/projects/${id}/changes`, { clips: { create: [clip()] } }, headers);
        expect(reused.status).toBe(409);
        expect(reused.body.error).toMatchObject({ type: "idempotency_error", code: "idempotency_key_reused" });
        const other = await project("Other");
        expect((await call("POST", `/v1/projects/${other}/changes`, { label: "x" }, headers)).status).toBe(200);
    });

    it("takes If-Match as r12, 12, \"12\" or 12-hash, and refuses a stale one with 412 and the revision", async () => {
        const id = await project();
        for (const [i, tag] of ['"r0"', "1", '"2"', '"3-abc"', 'W/"r4"'].entries()) {
            const answer = await change(id, { clips: { create: [clip({ start_time: i, end_time: i + 1 })] } }, { "if-match": tag });
            expect(answer.status).toBe(200);
        }
        const stale = await change(id, { clips: { create: [clip()] } }, { "if-match": '"r3"' });
        expect(stale.status).toBe(412);
        expect(stale.body.error).toMatchObject({ type: "precondition_failed", code: "timeline_changed", details: { revision: 5 } });
        expect((await change(id, { label: "x" }, { "if-match": "r-x" })).status).toBe(400);
        expect((await document(id)).body.clips).toHaveLength(5);
    });

    it("refuses an id twice in a changeset (invalid_change with its path)", async () => {
        const id = await project();
        const c = clip();
        const answer = await change(id, { clips: { create: [c], delete: [c.id] } });
        expect(answer.status).toBe(400);
        expect(answer.body.error).toMatchObject({ code: "invalid_change", details: { path: "clips.delete[0].id" } });
    });

    it("refuses missing rows with entity_missing {kind, ids} and applies nothing", async () => {
        const id = await project();
        const kept = clip();
        await change(id, { clips: { create: [kept] } });
        const missing = await change(id, { clips: { patch: [{ id: "zz", volume: 2 }, { id: "aa", volume: 2 }, { id: kept.id, volume: 3 }], delete: ["aa2"] } });
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatchObject({ type: "not_found", code: "entity_missing", details: { kind: "clip", ids: ["aa", "aa2", "zz"] } });
        const scenes = await change(id, { scenes: { patch: [{ id: "s1", caption: "x" }], delete: ["s0"] } });
        expect(scenes.body.error).toMatchObject({ code: "entity_missing", details: { kind: "scene", ids: ["s0", "s1"] } });
        const named = await change(id, { clips: { create: [clip({ scene_id: "ghost" })] } });
        expect(named.body.error).toMatchObject({ code: "entity_missing", details: { kind: "scene", ids: ["ghost"] } });
        const asset = await change(id, { media: { add: ["asset-x"] } });
        expect(asset.body.error).toMatchObject({ code: "entity_missing", details: { kind: "asset", ids: ["asset-x"] } });
        const doc = await document(id);
        expect(doc.body.revision).toBe(1);
        expect(doc.body.clips[0].volume).toBe(1);
    });

    it("refuses ids used anywhere with id_in_use", async () => {
        const one = await project("One");
        const two = await project("Two");
        const used = clip();
        const scene = uuid();
        await change(one, { clips: { create: [used] }, scenes: { create: [{ id: scene }] } });
        const clipAnswer = await change(two, { clips: { create: [{ ...used }] } });
        expect(clipAnswer.status).toBe(409);
        expect(clipAnswer.body.error).toMatchObject({ type: "conflict", code: "id_in_use", details: { kind: "clip", ids: [used.id] } });
        const sceneAnswer = await change(two, { scenes: { create: [{ id: scene }] } });
        expect(sceneAnswer.body.error).toMatchObject({ code: "id_in_use", details: { kind: "scene", ids: [scene] } });
        expect((await change(two, { scenes: { create: [{ id: "not-a-uuid" }] } })).body.error?.code).toBe("invalid_request");
    });

    it("refuses locked clips and clips on locked or hidden tracks (clip_locked); an unlock alone passes", async () => {
        const id = await project();
        const locked = clip({ locked: true });
        const free = clip({ track_index: 2 });
        await change(id, { clips: { create: [locked, free] } });
        const patch = await change(id, { clips: { patch: [{ id: locked.id, volume: 2 }] } });
        expect(patch.status).toBe(409);
        expect(patch.body.error).toMatchObject({ type: "conflict", code: "clip_locked", details: { kind: "clip", ids: [locked.id] } });
        expect((await change(id, { clips: { delete: [locked.id] } })).body.error?.code).toBe("clip_locked");
        expect((await change(id, { clips: { patch: [{ id: locked.id, locked: false }] } })).status).toBe(200);
        const hidden = await change(id, { tracks: { put: [{ type: "video", index: 2, visible: false }] }, clips: { patch: [{ id: free.id, volume: 2 }] } });
        expect(hidden.body.error).toMatchObject({ code: "clip_locked", details: { kind: "clip", ids: [free.id] } });
        await change(id, { tracks: { put: [{ type: "video", index: 3, locked: true }] } });
        const create = clip({ track_index: 3 });
        expect((await change(id, { clips: { create: [create] } })).body.error).toMatchObject({ code: "clip_locked", details: { ids: [create.id] } });
        const moveIn = await change(id, { clips: { patch: [{ id: free.id, track_index: 3 }] } });
        expect(moveIn.body.error).toMatchObject({ code: "clip_locked", details: { ids: [free.id] } });
    });

    it("refuses a patch that makes a clip end before it starts (invalid_change at that path)", async () => {
        const id = await project();
        const a = clip({ start_time: 0, end_time: 2 });
        await change(id, { clips: { create: [a] } });
        const answer = await change(id, { clips: { patch: [{ id: a.id, volume: 1 }, { id: uuid(), volume: 1 }] } });
        expect(answer.body.error?.code).toBe("entity_missing");
        const bad = await change(id, { clips: { patch: [{ id: a.id, start_time: 3 }] } });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatchObject({ code: "invalid_change", details: { path: "clips.patch[0].end_time" } });
        expect((await change(id, { clips: { create: [clip({ start_time: 2, end_time: 2 })] } })).body.error?.code).toBe("invalid_request");
    });

    it("clears a nullable field with null, keeps an absent one, and refuses null on the rest", async () => {
        const id = await project();
        const a = clip({ label: "L", text_content: "T", volume: 2 });
        await change(id, { clips: { create: [a] } });
        const answer = await change(id, { clips: { patch: [{ id: a.id, label: null }] } });
        expect(answer.body.clips[0]).toMatchObject({ label: null, text_content: "T", volume: 2 });
        const refused = await change(id, { clips: { patch: [{ id: a.id, volume: null }] } });
        expect(refused.status).toBe(400);
        expect(refused.body.error?.message).toBe("clips.patch.0: Value error, volume can't be null");
        const scene = uuid();
        await change(id, { scenes: { create: [{ id: scene, overlay_text: "o", fit_mode: "fill" }] } });
        const cleared = await change(id, { scenes: { patch: [{ id: scene, overlay_text: null, fit_mode: null }] } });
        expect(cleared.body.scenes[0]).toMatchObject({ overlay_text: null, fit_mode: null });
        expect((await change(id, { scenes: { patch: [{ id: scene, caption: null }] } })).status).toBe(400);
    });

    it.each([
        ["volume", 4.01], ["playback_speed", 0], ["playback_speed", 100.5], ["scale", 0], ["position_x", 10.5], ["rotation_degrees", -3601],
        ["keyframes_json", "x".repeat(65_537)], ["text_content", "x".repeat(5001)], ["text_style", "x".repeat(8193)], ["transition_params_json", "[]"],
        ["extras_json", "nope"], ["extras_json", JSON.stringify({ x: "y".repeat(65_536) })], ["media_url", "https://elsewhere.example/v.mp4"],
        ["media_url", "/files/uploads/temp/o/t.mp4"], ["track_type", "subtitle"], ["track_index", 100], ["crop_left", 1.1], ["custom_graphic_id", "bad id"],
    ])("refuses the clip field %s = %j", async (field, value) => {
        const id = await project();
        const resolved = field === "media_url" && typeof value === "string" && value.startsWith("/") ? `${fake.url}${value}` : value;
        const answer = await change(id, { clips: { create: [clip({ [field]: resolved })] } });
        expect(answer.status).toBe(400);
        expect(answer.body.error?.code).toBe("invalid_request");
    });

    it.each([
        ["card_config", "[]"], ["card_config", JSON.stringify({ x: "y".repeat(16_384) })], ["fit_mode", "stretch"], ["start_time", "1 min"],
        ["transform_scale", 0], ["transform_offset_x", -11], ["source_width", 0], ["duration", 3601], ["track_index", 0], ["visual_transition", "x".repeat(31)],
        ["objects_in_scene", Array.from({ length: 51 }, () => "o")],
    ])("refuses the scene field %s = %j", async (field, value) => {
        const id = await project();
        const answer = await change(id, { scenes: { create: [{ id: uuid(), [field]: value }] } });
        expect(answer.status).toBe(400);
    });

    it("refuses unknown keys anywhere in the body", async () => {
        const id = await project();
        for (const body of [{ extra: 1 }, { clips: { upsert: [] } }, { clips: { create: [clip({ ai_prompt: "x" })] } }, { clips: { patch: [{ clip_id: "x" }] } }, { project: { product_type: "movie" } }]) {
            const answer = await change(id, body);
            expect(answer.status).toBe(400);
            expect(answer.body.error?.code).toBe("invalid_request");
        }
    });

    it("resequences scenes after the write and answers the scenes whose order changed", async () => {
        const id = await project();
        const [a, b, c] = [uuid(), uuid(), uuid()];
        const created = await change(id, { scenes: { create: [{ id: a, timeline_position_seconds: 10 }, { id: b, timeline_position_seconds: 0 }, { id: c, timeline_position_seconds: 5, order: 7 }] } });
        expect(created.body.scenes.map((s: { id: string; order: number }) => [s.id, s.order])).toEqual([[b, 0], [c, 1], [a, 2]]);
        const moved = await change(id, { scenes: { patch: [{ id: a, timeline_position_seconds: 1 }] } });
        // b kept its order (0): only the patched scene and the one whose order moved come back.
        expect(moved.body.scenes.map((s: { id: string; order: number }) => [s.id, s.order])).toEqual([[a, 1], [c, 2]]);
        const deleted = await change(id, { scenes: { delete: [b] } });
        expect(deleted.body.deleted).toEqual({ clips: [], scenes: [b] });
        expect(deleted.body.scenes.map((s: { id: string; order: number }) => [s.id, s.order])).toEqual([[a, 0], [c, 1]]);
        expect((await document(id)).body.scenes.map((s: { id: string }) => s.id)).toEqual([a, c]);
    });

    it("rounds an ai_video scene's patched duration to 5, 10 or 15 as the server does (not a create)", async () => {
        const id = await project();
        const [ai, clipScene] = [uuid(), uuid()];
        const created = await change(id, { scenes: { create: [{ id: ai, duration: 3.2 }, { id: clipScene, card_type: "source_clip", duration: 3.2 }] } });
        expect(created.body.scenes.map((s: { duration: number }) => s.duration)).toEqual([3.2, 3.2]);
        const patched = await change(id, { scenes: { patch: [{ id: ai, duration: 7.4 }, { id: clipScene, duration: 7.4 }] } });
        expect(patched.body.scenes.map((s: { id: string; duration: number }) => [s.id, s.duration])).toEqual([[ai, 5], [clipScene, 7.4]]);
    });

    it("replaces effect stacks whole, deletes a scene's clips' links, and removes tracks with their clips", async () => {
        const id = await project();
        const scene = uuid();
        const a = clip({ scene_id: scene, effects: [{ effect_id: "a" }, { effect_id: "b", order: 1 }] });
        const onAudio = clip({ track_type: "audio", track_index: 2 });
        await change(id, { scenes: { create: [{ id: scene }] }, clips: { create: [a, onAudio] }, tracks: { put: [{ type: "audio", index: 2, label: "Music" }] } });
        const stack = await change(id, { clips: { patch: [{ id: a.id, effects: [{ effect_id: "c", enabled: false }] }] } });
        expect(stack.body.clips[0].effects).toEqual([{ effect_id: "c", order: 0, enabled: false, params_json: null }]);
        expect((await change(id, { clips: { patch: [{ id: a.id, effects: null }] } })).body.clips[0].effects).toEqual([]);
        const unlinked = await change(id, { scenes: { delete: [scene] } });
        expect(unlinked.body.clips).toEqual([expect.objectContaining({ id: a.id, scene_id: null })]);
        const removed = await change(id, { tracks: { removed: [{ type: "audio", index: 2 }] } });
        expect(removed.body.deleted).toEqual({ clips: [onAudio.id], scenes: [] });
        expect(removed.body.tracks.map((t: { type: string; index: number }) => `${t.type}${t.index}`)).toEqual(["video1", "audio1"]);
        expect((await document(id)).body.clips.map((c: { id: string }) => c.id)).toEqual([a.id]);
    });

    it("puts tracks (merged by type and index) and answers all tracks only when tracks were sent", async () => {
        const id = await project();
        const put = await change(id, { tracks: { put: [{ type: "text", index: 1, label: "  " }, { type: "video", index: 1, muted: true }] } });
        expect(put.body.tracks).toEqual([
            { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "video", index: 1, label: "V1", muted: true, locked: false, visible: true, volume: 1 },
        ]);
        const again = await change(id, { tracks: { put: [{ type: "video", index: 1, label: "Main" }] } });
        expect(again.body.tracks.map((t: { label: string }) => t.label)).toEqual(["Main", "T1"]);
        expect((await change(id, { clips: { create: [clip()] } })).body.tracks).toBeNull();
    });

    it("writes project fields and answers the DocumentProjectView", async () => {
        const id = await project();
        const answer = await change(id, { project: { name: "New", extras_json: '{"fps":24}', music_url: files("m.mp3"), music_volume: 2 } });
        expect(answer.body.project).toMatchObject({ id, name: "New", extras_json: '{"fps":24}', music_url: files("m.mp3"), music_volume: 2, timeline_revision: 1 });
        expect((await change(id, { project: { extras_json: null } })).body.project.extras_json).toBeNull();
        expect((await change(id, { project: { name: null } })).status).toBe(400);
        expect((await change(id, { project: { music_volume: 2.5 } })).status).toBe(400);
    });

    it("does not bump the revision for a changeset that changes nothing (but keeps the device)", async () => {
        const id = await project();
        const answer = await change(id, { label: "Nothing", device: "Phone" });
        expect(answer.body).toMatchObject({ revision: 0, etag: '"r0"', clips: [], scenes: [] });
        expect((await call("GET", `/v1/projects/${id}`)).body).toMatchObject({ timeline_revision: 0, last_edited_device: "Phone" });
        const a = clip();
        await change(id, { clips: { create: [a] } });
        expect((await change(id, { clips: { patch: [{ id: a.id, volume: 1 }] } })).body.revision).toBe(1);
    });

    it("refuses more than 1,000 scenes or 5,000 clips with project_too_large", async () => {
        const scenes = Array.from({ length: 500 }, () => ({ id: uuid() }));
        const clips = Array.from({ length: 5000 }, (_, i) => ({ id: uuid(), track_type: "video", track_index: 1, start_time: i, end_time: i + 1 }));
        const imported = await call("POST", "/v1/projects/import", { project: { name: "Big" }, scenes, timeline: { clips } });
        expect(imported.status).toBe(201);
        const id = imported.body.project.id as string;
        const tooMany = await change(id, { clips: { create: [clip()] } });
        expect(tooMany.status).toBe(403);
        expect(tooMany.body.error).toMatchObject({ type: "permission_error", code: "project_too_large" });
        expect((await change(id, { scenes: { create: Array.from({ length: 500 }, () => ({ id: uuid() })) } })).status).toBe(200);
        expect((await change(id, { scenes: { create: [{ id: uuid() }] } })).body.error?.code).toBe("project_too_large");
        const deleteOne = await change(id, { clips: { delete: [imported.body.clip_ids[clips[0]!.id]] } });
        expect(deleteOne.status).toBe(200);
    });
});

describe("knobs", () => {
    it("remote-change applies a changeset as another device (no If-Match) and bump moves the revision", async () => {
        const id = await project();
        const scene = uuid();
        const remote = await knob("remote-change", { project_id: id, device: "Web", changes: { scenes: { create: [{ id: scene, caption: "From the web" }] } } });
        expect(remote).toEqual({ status: 200, body: { revision: 1 } });
        expect((await call("GET", `/v1/projects/${id}`)).body.last_edited_device).toBe("Web");
        expect(await knob("bump", { project_id: id })).toEqual({ status: 200, body: { revision: 2 } });
        const stale = await change(id, { scenes: { patch: [{ id: scene, caption: "Mine" }] } }, { "if-match": '"r1"' });
        expect(stale.body.error?.details).toEqual({ revision: 2 });
        const refused = await knob("remote-change", { project_id: id, changes: { scenes: { patch: [{ id: "gone", caption: "x" }] } } });
        expect(refused.status).toBe(404);
        expect(refused.body.error.code).toBe("entity_missing");
        expect((await fake.cloud.remoteChange(id, { scenes: { patch: [{ id: scene, caption: "In process" }] } })).revision).toBe(3);
        expect(fake.cloud.bump(id)).toEqual({ revision: 4 });
    });

    it("lock-clip and delete-entity change rows as the server would and bump the revision", async () => {
        const id = await project();
        const a = clip();
        const scene = uuid();
        await change(id, { clips: { create: [a] }, scenes: { create: [{ id: scene }] } });
        expect((await knob("lock-clip", { project_id: id, clip_id: a.id, locked: true })).body).toEqual({ revision: 2 });
        expect((await change(id, { clips: { patch: [{ id: a.id, volume: 2 }] } })).body.error?.code).toBe("clip_locked");
        expect((await knob("delete-entity", { project_id: id, kind: "scene", id: scene })).body).toEqual({ revision: 3 });
        expect((await knob("delete-entity", { project_id: id, kind: "clip", id: a.id })).body).toEqual({ revision: 4 });
        expect((await knob("delete-entity", { project_id: id, kind: "clip", id: a.id })).status).toBe(404);
        const doc = await document(id);
        expect(doc.body).toMatchObject({ revision: 4, clips: [], scenes: [] });
    });

    it("offline 503 answers every /v1 call, drop destroys the socket, off restores", async () => {
        await knob("offline", { mode: "503" });
        const answer = await call("GET", "/v1/projects");
        expect(answer.status).toBe(503);
        expect(answer.body.error).toMatchObject({ type: "unavailable", code: "unavailable" });
        expect((await fetch(`${fake.url}/files/generated.png`)).status).toBe(503);
        await knob("offline", { mode: "drop" });
        await expect(fetch(`${fake.url}/v1/projects`, { headers: { authorization: `Bearer ${key}` } })).rejects.toThrow();
        fake.cloud.setOffline("off");
        expect((await call("GET", "/v1/projects")).status).toBe(200);
        expect(fake.state().requests.filter((r) => r.path === "/v1/projects")).toHaveLength(3);
    });

    it("latency slows matching paths", async () => {
        await knob("latency", { ms: 150, path_prefix: "/v1/projects" });
        let started = Date.now();
        await call("GET", "/v1/projects");
        expect(Date.now() - started).toBeGreaterThanOrEqual(140);
        started = Date.now();
        await call("GET", "/v1/account");
        expect(Date.now() - started).toBeLessThan(140);
        fake.cloud.setLatency(0);
        started = Date.now();
        await call("GET", "/v1/projects");
        expect(Date.now() - started).toBeLessThan(140);
    });

    it("fail-next-change answers the next changesets with the given error, then works", async () => {
        const id = await project();
        await knob("fail-next-change", { status: 409, code: "clip_locked", details: { kind: "clip", ids: ["x"] }, count: 2 });
        for (let i = 0; i < 2; i += 1) {
            const refused = await change(id, { clips: { create: [clip()] } });
            expect(refused.status).toBe(409);
            expect(refused.body.error).toMatchObject({ type: "conflict", code: "clip_locked", details: { kind: "clip", ids: ["x"] } });
        }
        expect((await change(id, { clips: { create: [clip()] } })).status).toBe(200);
        fake.cloud.failNextChange({ status: 503, code: "unavailable" });
        expect((await change(id, { label: "x" })).body.error).toMatchObject({ type: "unavailable", code: "unavailable" });
    });

    it("storm-412 refuses the next changesets with If-Match, bumping the revision each time", async () => {
        const id = await project();
        await knob("storm-412", { count: 2 });
        expect((await change(id, { label: "a" })).status).toBe(200); // no If-Match: not part of the storm
        const one = await change(id, { label: "a" }, { "if-match": "0" });
        expect(one.body.error).toMatchObject({ code: "timeline_changed", details: { revision: 1 } });
        const two = await change(id, { label: "a" }, { "if-match": "1" });
        expect(two.body.error?.details).toEqual({ revision: 2 });
        expect((await change(id, { label: "a" }, { "if-match": "2" })).status).toBe(200);
    });

    it("expire-key answers the next authenticated /v1 call with 401 once", async () => {
        await knob("expire-key");
        const refused = await call("GET", "/v1/projects");
        expect(refused.status).toBe(401);
        expect(refused.body.error).toMatchObject({ type: "authentication_error", code: "invalid_api_key" });
        expect((await call("GET", "/v1/projects")).status).toBe(200);
    });

    it("state lists projects, changes and reads; reset clears every cloud knob and record", async () => {
        const id = await project();
        const a = clip();
        await change(id, { clips: { create: [a] }, device: "Mac" }, { "if-match": '"r0"', "idempotency-key": "first" });
        await change(id, { clips: { create: [a] } }, { "if-match": '"r0"' });
        const state = await cloudState();
        expect(state.projects).toEqual([expect.objectContaining({ id, name: "Film", revision: 1, deleted_at: null, origin: "studio", last_edited_device: "Mac", extras_json: null })]);
        expect(state.projects[0].clips).toEqual([expect.objectContaining({ id: a.id })]);
        expect(state.projects[0].tracks).toHaveLength(2);
        expect(state.changes).toEqual([
            expect.objectContaining({ project_id: id, key: "first", if_match: '"r0"', status: 200 }),
            expect.objectContaining({ project_id: id, if_match: '"r0"', status: 412 }),
        ]);
        expect(fake.cloud.state().changes).toHaveLength(2);
        await knob("offline", { mode: "503" });
        await fetch(`${fake.url}/__test/reset`);
        key = fake.mintKey();
        expect((await call("GET", "/v1/projects")).body.data).toEqual([]);
        expect(await cloudState()).toMatchObject({ projects: [], changes: [], document_reads: 0, document_304s: 0 });
    });

    it("set-shots gives a scene read-only shots in the document", async () => {
        const id = await project();
        const scene = uuid();
        await change(id, { scenes: { create: [{ id: scene }] } });
        await knob("set-shots", { project_id: id, scene_id: scene, shots: [{ description: "Wide", duration: 2 }] });
        expect((await document(id)).body.scenes[0].shots).toEqual([{ index: 0, description: "Wide", duration: 2, image_url: null, end_image_url: null, video_url: null, dialogue: null }]);
    });

    it("refuses unknown knobs and bad knob bodies", async () => {
        expect((await knob("nope")).status).toBe(404);
        expect((await knob("offline", { mode: "sideways" })).status).toBe(400);
        expect((await knob("bump", { project_id: "missing" })).status).toBe(404);
    });
});

// ── uploads v2, the gateway, files and storage ───────────────────────────────────────────────────────────────────

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const OWNER = /[0-9a-f]{24}/.source;
const put = (url: string, bytes: Uint8Array, type = "audio/wav", headers: Record<string, string> = {}) =>
    fetch(url, { method: "PUT", headers: { "content-type": type, ...headers }, body: bytes as Uint8Array<ArrayBuffer> });
const startUpload = (body: Record<string, unknown>) => call("POST", "/v1/uploads", { filename: "clip.wav", content_type: "audio/wav", ...body });

describe("uploads v2", () => {
    it("takes a tool input as a temp upload through the single-use gateway URL", async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const start = await startUpload({ size_bytes: 4 });
        expect(start.status).toBe(201);
        expect(Object.keys(start.body)).toEqual(["object", "upload_id", "upload_url", "method", "headers", "media_url", "expires_at", "multipart", "scope"]);
        expect(start.body).toMatchObject({ object: "upload", method: "PUT", headers: { "Content-Type": "audio/wav", "Content-Length": "4" }, multipart: null, scope: "temp" });
        expect(start.body.upload_id).toMatch(/^up_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(start.body.upload_url).toMatch(new RegExp(`^${fake.url}/u/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
        expect(start.body.media_url).toMatch(new RegExp(`^${fake.url}/files/uploads/temp/${OWNER}/[a-z2-7]{24}\\.wav$`));
        expect(Date.parse(start.body.expires_at) - Date.now()).toBeGreaterThan(3_500_000);
        const id = start.body.upload_id as string;
        expect((await call("POST", `/v1/uploads/${id}/complete`)).body.error).toMatchObject({ type: "conflict", code: "upload_not_received" });

        const withKey = await put(start.body.upload_url, bytes, "audio/wav", { authorization: `Bearer ${key}` });
        expect(withKey.status).toBe(403);
        const wrongType = await put(start.body.upload_url, bytes, "audio/mpeg");
        expect(wrongType.status).toBe(400);
        expect((await wrongType.json()).error.code).toBe("upload_type_mismatch");
        const wrongSize = await put(start.body.upload_url, new Uint8Array(5));
        expect(wrongSize.status).toBe(400);
        expect((await wrongSize.json()).error.code).toBe("upload_size_mismatch");
        const sent = await put(start.body.upload_url, bytes);
        expect(sent.status).toBe(200);
        const etag = (await sent.json()).etag as string;
        expect(etag).toMatch(/^[0-9a-f]{32}$/);
        expect(sent.headers.get("etag")).toBe(`"${etag}"`);
        const replay = await put(start.body.upload_url, bytes);
        expect(replay.status).toBe(410);
        expect((await replay.json()).error).toMatchObject({ type: "conflict", code: "upload_url_used" });

        const done = await call("POST", `/v1/uploads/${id}/complete`);
        expect(done.status).toBe(200);
        expect(Object.keys(done.body)).toEqual(["object", "asset_id", "media_url", "content_type", "size_bytes", "project_id", "scope", "expires_at"]);
        expect(done.body).toMatchObject({ object: "upload", media_url: start.body.media_url, content_type: "audio/wav", size_bytes: 4, project_id: null, scope: "temp" });
        expect(Date.parse(done.body.expires_at) - Date.now()).toBeGreaterThan(86_000_000);
        expect((await call("POST", `/v1/uploads/${id}/complete`)).body).toEqual(done.body);
        const file = await fetch(start.body.media_url);
        expect(file.headers.get("content-type")).toBe("audio/wav");
        expect(file.headers.get("accept-ranges")).toBe("bytes");
        expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
        expect((await call("POST", "/v1/uploads/up_nope.x/complete")).body.error).toMatchObject({ type: "not_found", code: "upload_not_found" });

        const state = fake.state();
        expect(state.uploads).toEqual([{ id, contentType: "audio/wav", sizeBytes: 4, filename: "clip.wav", put: true, completed: true }]);
        expect(state.requests.filter((r) => r.method === "PUT" && r.path.startsWith("/u/")).map((r) => r.authorized)).toEqual([true, false, false, false, false]);
        const cloud = await cloudState();
        expect(cloud.uploads).toEqual([{ id, scope: "temp", project_id: null, sha256: null, size_bytes: 4, puts: 1, completed: true, transport: "gateway", gateway_tokens_used: 1 }]);
        expect(cloud.assets).toEqual([{ id: done.body.asset_id, sha256: null, size_bytes: 4, content_type: "audio/wav", scope: "temp", media_url: start.body.media_url, project_ids: [] }]);
        expect(cloud.storage).toMatchObject({ media_bytes: 0, temp_bytes: 4, today: { uploads: 1, upload_bytes: 4 } });
    });

    it("stores a project upload in the project's folder and links it into the media bin", async () => {
        const id = await project();
        const start = await startUpload({ size_bytes: 3, project_id: id });
        expect(start.body.scope).toBe("project");
        expect(start.body.media_url).toMatch(new RegExp(`^${fake.url}/files/projects/${id}/uploads/[a-z2-7]{24}\\.wav$`));
        await put(start.body.upload_url, new Uint8Array([7, 8, 9]));
        const done = await call("POST", `/v1/uploads/${start.body.upload_id}/complete`);
        expect(done.body).toMatchObject({ project_id: id, scope: "project", expires_at: null });
        const doc = await document(id);
        expect(doc.body.media).toEqual([{
            id: done.body.asset_id, kind: "audio", source: "upload", url: start.body.media_url, scene_id: null, filename: "clip.wav", size_bytes: 3,
            created_at: expect.stringMatching(/Z$/), asset_id: done.body.asset_id, sha256: null,
        }]);
        expect(doc.body.project.media_bytes).toBe(3);
        expect((await startUpload({ size_bytes: 3, project_id: "missing" })).status).toBe(404);
        const used = await change(id, { clips: { create: [clip({ media_url: start.body.media_url })] } });
        expect(used.status).toBe(200);
    });

    it("deduplicates an account upload by sha256, size and type (200, linked, no daily count)", async () => {
        const one = await project("One");
        const two = await project("Two");
        const bytes = new Uint8Array([5, 6, 7]);
        const hash = sha(bytes);
        const start = await startUpload({ size_bytes: 3, sha256: hash, scope: "account", project_id: one, multipart: true });
        expect(start.status).toBe(201);
        expect(start.body.media_url).toBe(`${fake.url}/files/uploads/media/${start.body.media_url.split("/")[6]}/${hash}.wav`);
        expect(start.body.media_url).toMatch(new RegExp(`/uploads/media/${OWNER}/${hash}\\.wav$`));
        await put(start.body.upload_url, bytes);
        const done = await call("POST", `/v1/uploads/${start.body.upload_id}/complete`, { parts: null });
        expect(done.body).toMatchObject({ scope: "account", project_id: one, expires_at: null });
        const again = await startUpload({ size_bytes: 3, sha256: hash, scope: "account", project_id: two });
        expect(again.status).toBe(200);
        expect(Object.keys(again.body)).toEqual(["object", "deduplicated", "asset_id", "media_url", "content_type", "size_bytes", "project_id"]);
        expect(again.body).toEqual({ object: "upload", deduplicated: true, asset_id: done.body.asset_id, media_url: done.body.media_url, content_type: "audio/wav", size_bytes: 3, project_id: two });
        expect((await document(two)).body.media).toEqual([expect.objectContaining({ asset_id: done.body.asset_id, sha256: hash })]);
        expect((await startUpload({ size_bytes: 3, sha256: hash, content_type: "audio/mpeg", filename: "a.mp3", scope: "account" })).status).toBe(201);
        const storage = await call("GET", "/v1/storage");
        expect(storage.body.today).toEqual({ uploads: 2, upload_bytes: 6 });
        expect(storage.body.media_bytes).toBe(6); // 3 stored + 3 held by the pending mp3 upload
    });

    it("returns the stored asset when two account uploads of one file complete", async () => {
        const bytes = new Uint8Array([1, 1, 2, 3]);
        const hash = sha(bytes);
        const a = await startUpload({ size_bytes: 4, sha256: hash, scope: "account" });
        const b = await startUpload({ size_bytes: 4, sha256: hash, scope: "account" });
        await put(a.body.upload_url, bytes);
        await put(b.body.upload_url, bytes);
        const first = await call("POST", `/v1/uploads/${a.body.upload_id}/complete`);
        const second = await call("POST", `/v1/uploads/${b.body.upload_id}/complete`);
        expect(second.body.asset_id).toBe(first.body.asset_id);
        expect((await cloudState()).assets).toHaveLength(1);
        expect((await call("GET", "/v1/storage")).body.media_bytes).toBe(4);
    });

    it.each([
        [{ size_bytes: 4, scope: "account" }, "scope account needs the file's sha256"],
        [{ size_bytes: 4, scope: "temp", project_id: "p1" }, "scope temp takes no project_id"],
        [{ size_bytes: 4, sha256: "ABC" }, "sha256"],
        [{ size_bytes: 4, scope: "forever" }, "scope"],
        [{ size_bytes: 4, multipart: null }, "multipart"],
        [{ size_bytes: 4, project_id: "bad id" }, "project_id"],
        [{ size_bytes: 1.5 }, "size_bytes"],
    ])("refuses the upload body %j", async (body, words) => {
        const answer = await startUpload(body);
        expect(answer.status).toBe(400);
        expect(answer.body.error?.message).toContain(words);
    });

    it("sends a big file in parts (multipart), refusing missing or wrong part ETags", async () => {
        await knob("upload-limits", { single_put_max_bytes: 10, part_size: 4 });
        expect((await startUpload({ size_bytes: 10 })).body.upload_url).toMatch(/\/u\//);
        const refused = await startUpload({ size_bytes: 11 });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatchObject({ code: "multipart_required" });
        const start = await startUpload({ size_bytes: 11, multipart: true });
        expect(start.status).toBe(201);
        expect(start.body.upload_url).toBeNull();
        expect(start.body.multipart.part_size).toBe(4);
        expect(start.body.multipart.parts.map((p: { number: number; size: number }) => [p.number, p.size])).toEqual([[1, 4], [2, 4], [3, 3]]);
        const bytes = Uint8Array.from({ length: 11 }, (_, i) => i);
        const etags: string[] = [];
        for (const part of start.body.multipart.parts as Array<{ number: number; size: number; url: string }>) {
            const slice = bytes.slice((part.number - 1) * 4, (part.number - 1) * 4 + part.size);
            const answer = await put(part.url, slice);
            const answerBody = await answer.json();
            expect(answerBody).toEqual({ part_number: part.number, etag: expect.any(String) });
            expect(answer.headers.get("etag")).toBe(`"${answerBody.etag}"`);
            etags.push(answerBody.etag);
            if (part.number === 1) expect((await put(part.url, slice)).status).toBe(410);
        }
        const id = start.body.upload_id as string;
        const complete = (parts: unknown) => call("POST", `/v1/uploads/${id}/complete`, parts === undefined ? undefined : { parts });
        expect((await complete(undefined)).body.error?.code).toBe("upload_parts_invalid");
        expect((await complete([{ number: 1, etag: etags[0] }, { number: 2, etag: etags[1] }])).body.error?.code).toBe("upload_parts_invalid");
        expect((await complete([{ number: 1, etag: etags[0] }, { number: 2, etag: "nope" }, { number: 3, etag: etags[2] }])).body.error?.code).toBe("upload_parts_invalid");
        const done = await complete([{ number: 3, etag: etags[2] }, { number: 1, etag: etags[0] }, { number: 2, etag: etags[1] }]);
        expect(done.status).toBe(200);
        const file = await fetch(done.body.media_url);
        expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
        const range = await fetch(done.body.media_url, { headers: { range: "bytes=2-5" } });
        expect(range.status).toBe(206);
        expect(range.headers.get("content-range")).toBe("bytes 2-5/11");
        expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3, 4, 5]);
        const suffix = await fetch(done.body.media_url, { headers: { range: "bytes=-2" } });
        expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([9, 10]);
        const open = await fetch(done.body.media_url, { headers: { range: "bytes=9-" } });
        expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([9, 10]);
        const outside = await fetch(done.body.media_url, { headers: { range: "bytes=20-30" } });
        expect(outside.status).toBe(416);
        expect(outside.headers.get("content-range")).toBe("bytes */11");
        expect((await fetch(`${fake.url}/files/uploads/nothing.wav`)).status).toBe(404);
        expect((await cloudState()).uploads[1]).toMatchObject({ transport: "multipart", puts: 3, gateway_tokens_used: 3, completed: true });
    });

    it("takes a big tool input (scope temp) in parts too (9a.1); temp_multipart: false answers multipart_required like an older server", async () => {
        await knob("upload-limits", { single_put_max_bytes: 10, part_size: 4 });
        const start = await startUpload({ size_bytes: 11, multipart: true });
        expect(start.status).toBe(201);
        expect(start.body.scope).toBe("temp");
        const bytes = Uint8Array.from({ length: 11 }, (_, i) => 20 + i);
        const parts: Array<{ number: number; etag: string }> = [];
        for (const part of start.body.multipart.parts as Array<{ number: number; size: number; url: string }>) {
            const answer = await put(part.url, bytes.slice((part.number - 1) * 4, (part.number - 1) * 4 + part.size));
            parts.push({ number: part.number, etag: (await answer.json()).etag });
        }
        const done = await call("POST", `/v1/uploads/${start.body.upload_id}/complete`, { parts });
        expect(done.body).toMatchObject({ scope: "temp", expires_at: expect.stringMatching(/Z$/) });
        expect(done.body.media_url).toContain("/uploads/temp/");
        expect([...new Uint8Array(await (await fetch(done.body.media_url)).arrayBuffer())]).toEqual([...bytes]);
        expect((await cloudState()).uploads.at(-1)).toMatchObject({ scope: "temp", transport: "multipart", completed: true });
        expect((await knob("upload-limits", { temp_multipart: false })).body).toMatchObject({ temp_multipart: false });
        const refused = await startUpload({ size_bytes: 11, multipart: true });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatchObject({ code: "multipart_required" });
        // Cloud project media still take parts.
        expect((await startUpload({ size_bytes: 11, multipart: true, scope: "account", sha256: "a".repeat(64) })).status).toBe(201);
        expect((await knob("upload-limits", { temp_multipart: "yes" })).status).toBe(400);
    });

    it("keeps the old presigned /__uploads/<id> PUT working for a single upload", async () => {
        const start = await startUpload({ size_bytes: 2 });
        const legacy = `${fake.url}/__uploads/${start.body.upload_id}`;
        expect((await put(legacy, new Uint8Array([1, 2]), "audio/mpeg")).status).toBe(400);
        expect((await put(legacy, new Uint8Array([1, 2]), "audio/wav", { authorization: "Bearer x" })).status).toBe(403);
        expect((await put(`${fake.url}/__uploads/up_missing`, new Uint8Array([1, 2]))).status).toBe(404);
        expect((await put(legacy, new Uint8Array([1, 2]))).status).toBe(200);
        expect((await call("POST", `/v1/uploads/${start.body.upload_id}/complete`)).status).toBe(200);
    });

    it("answers CORS preflights of the gateway and exposes ETag and Retry-After", async () => {
        const preflight = await fetch(`${fake.url}/u/a.b`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173" } });
        expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
        expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
        for (const name of ["content-type", "idempotency-key", "if-match", "if-none-match"]) expect(preflight.headers.get("access-control-allow-headers")).toContain(name);
        const answer = await fetch(`${fake.url}/v1/storage`, { headers: { authorization: `Bearer ${key}`, origin: "http://localhost:4173" } });
        expect(answer.headers.get("access-control-expose-headers")).toBe("etag, retry-after");
        expect((await fetch(`${fake.url}/v1/storage`, { headers: { authorization: `Bearer ${key}`, origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("storage", () => {
    it("answers the StorageView with the free plan's limits", async () => {
        const storage = await call("GET", "/v1/storage");
        const limits = { media_bytes: 2 * 1024 ** 3, project_data_bytes: 250 * 1024 ** 2, uploads_per_day: 100, upload_bytes_per_day: 2 * 1024 ** 3 };
        expect(storage.body).toEqual({
            object: "storage", media_bytes: 0, project_data_bytes: 0, included: limits, purchased: { media_bytes: 0, project_data_bytes: 0, uploads_per_day: 0, upload_bytes_per_day: 0 },
            limits, today: { uploads: 0, upload_bytes: 0 }, temp_bytes: 0, temp_limit_bytes: 2 * 1024 ** 3, state: "ok", grace_ends_at: null, blocks: [],
        });
        await project();
        expect((await call("GET", "/v1/storage")).body.project_data_bytes).toBeGreaterThan(0);
    });

    it("refuses uploads over the media quota (403), the temp limit (429), the daily limits (429) and a full pool (503)", async () => {
        const id = await project();
        await knob("storage", { media_limit_bytes: 10, media_used_extra_bytes: 8 });
        expect((await call("GET", "/v1/storage")).body).toMatchObject({ media_bytes: 8, limits: { media_bytes: 10 }, state: "ok" });
        const full = await startUpload({ size_bytes: 3, project_id: id });
        expect(full.status).toBe(403);
        expect(full.body.error).toMatchObject({ type: "permission_error", code: "storage_quota_exceeded" });
        expect((await startUpload({ size_bytes: 3 })).status).toBe(201); // a temp upload is not media
        await knob("storage", { media_used_extra_bytes: 10 });
        expect((await call("GET", "/v1/storage")).body.state).toBe("over_quota");

        fake.cloud.setStorage({ temp_limit_bytes: 5, media_limit_bytes: 1000 });
        const temp = await startUpload({ size_bytes: 3 });
        expect(temp.status).toBe(429);
        expect(temp.body.error).toMatchObject({ type: "rate_limit_error", code: "temp_storage_exceeded" });
        expect(temp.headers.get("retry-after")).toBe("600");

        fake.cloud.setStorage({ temp_limit_bytes: 1000, uploads_per_day: 2 });
        expect((await startUpload({ size_bytes: 1 })).status).toBe(201);
        const daily = await startUpload({ size_bytes: 1 });
        expect(daily.status).toBe(429);
        expect(daily.body.error).toMatchObject({ type: "rate_limit_error", code: "upload_daily_limit" });
        const wait = Number(daily.headers.get("retry-after"));
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        expect(Math.abs(wait - (midnight.getTime() - Date.now()) / 1000)).toBeLessThan(5);
        fake.cloud.setStorage({ uploads_per_day: 100, upload_bytes_per_day: 6 });
        expect((await startUpload({ size_bytes: 4 })).body.error?.code).toBe("upload_daily_limit");
        expect((await startUpload({ size_bytes: 7 })).body.error?.code).toBe("upload_daily_limit");

        fake.cloud.setStorage({ upload_bytes_per_day: 1000, pool_full: true });
        const pool = await startUpload({ size_bytes: 1 });
        expect(pool.status).toBe(503);
        expect(pool.body.error).toMatchObject({ type: "unavailable", code: "free_storage_pool_full" });
        expect((await call("GET", "/v1/storage")).body.state).toBe("pool_full");
    });

    it("refuses a changeset that grows project data past the limit (project_data_quota_exceeded)", async () => {
        const id = await project();
        const used = (await call("GET", "/v1/storage")).body.project_data_bytes as number;
        await knob("storage", { project_data_limit_bytes: used + 100 });
        const answer = await change(id, { clips: { create: [clip({ text_content: "x".repeat(500) })] } });
        expect(answer.status).toBe(403);
        expect(answer.body.error).toMatchObject({ type: "permission_error", code: "project_data_quota_exceeded" });
        expect((await change(id, { label: "nothing" })).status).toBe(200);
        expect((await call("POST", "/v1/projects", { name: "More" })).body.error?.code).toBe("project_data_quota_exceeded");
    });

    it("links an uploaded asset with media.add and forgets uploads on reset", async () => {
        const id = await project();
        const start = await startUpload({ size_bytes: 1, project_id: id });
        await put(start.body.upload_url, new Uint8Array([1]));
        const done = await call("POST", `/v1/uploads/${start.body.upload_id}/complete`);
        const other = await project("Other");
        expect((await change(other, { media: { add: [done.body.asset_id] } })).status).toBe(200);
        expect((await document(other)).body.media).toHaveLength(1);
        expect((await change(other, { media: { remove: [done.body.asset_id] } })).status).toBe(200);
        expect((await document(other)).body.media).toEqual([]);
        fake.reset();
        key = fake.mintKey();
        expect(await cloudState()).toMatchObject({ uploads: [], assets: [] });
        expect((await fetch(start.body.media_url)).status).toBe(404);
        expect((await call("GET", "/v1/storage")).body.limits.media_bytes).toBe(2 * 1024 ** 3);
    });

    it("purges a project's own uploads with it", async () => {
        const id = await project();
        const start = await startUpload({ size_bytes: 2, project_id: id });
        await put(start.body.upload_url, new Uint8Array([1, 2]));
        await call("POST", `/v1/uploads/${start.body.upload_id}/complete`);
        expect((await call("GET", "/v1/storage")).body.media_bytes).toBe(2);
        await call("DELETE", `/v1/projects/${id}?permanent=true`);
        expect((await call("GET", "/v1/storage")).body.media_bytes).toBe(0);
        expect((await cloudState()).assets).toEqual([]);
    });
});

// ── storyboard sheets and shots versions (phase 9c, director design §11.1.3–4) ───────────────────────────────────

describe("storyboard sheets and shots versions", () => {
    const sheet = (n = 2) => ({ image_url: files("sheet.png"), panels: Array.from({ length: n }, (_, i) => ({ index: i, shot_index: i, image_url: files(`panel-${i}.png`) })) });
    const shots = (n = 2) => Array.from({ length: n }, (_, i) => ({ description: `Shot ${i + 1}`, duration: 2, image_url: files(`panel-${i}.png`) }));

    async function sceneWith(projectId: string): Promise<string> {
        const scene = uuid();
        await change(projectId, { scenes: { create: [{ id: scene }] } });
        return scene;
    }
    const sceneOf = async (projectId: string) => (await document(projectId)).body.scenes[0];

    it("shows each scene's storyboard sheets (ours only) and an opaque shots_version in the document and changeset answers", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        const empty = await sceneOf(id);
        expect(empty.storyboard_sheets).toEqual([]);
        expect(empty.shots_version).toMatch(/^sv_[0-9a-f]{24}$/);
        fake.cloud.setShots(id, scene, shots(), [sheet(), { image_url: "https://elsewhere.example/s.png", panels: [{ index: 0, shot_index: 0, image_url: "https://elsewhere.example/p.png" }] }]);
        const drawn = await sceneOf(id);
        expect(drawn.storyboard_sheets).toEqual([sheet(), { image_url: null, panels: [] }]);
        expect(drawn.shots_version).not.toBe(empty.shots_version);
        const answer = await change(id, { scenes: { patch: [{ id: scene, caption: "Hi" }] } });
        expect(answer.body.scenes[0]).toMatchObject({ storyboard_sheets: drawn.storyboard_sheets, shots_version: drawn.shots_version });
    });

    it("the sheet-views knob answers sheets as stored, other hosts included (a client must filter them itself)", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        const elsewhere = { image_url: "https://elsewhere.example/s.png", panels: [{ index: 0, shot_index: 0, image_url: "https://elsewhere.example/p.png" }] };
        fake.cloud.setShots(id, scene, shots(), [sheet(), elsewhere]);
        expect((await knob("sheet-views", { unfiltered: true })).status).toBe(200);
        expect((await sceneOf(id)).storyboard_sheets).toEqual([sheet(), elsewhere]);
        expect((await knob("sheet-views", { unfiltered: "yes" })).status).toBe(400);
        fake.reset();
        key = fake.mintKey();
        const again = await project();
        const drawn = await sceneWith(again);
        fake.cloud.setShots(again, drawn, shots(), [elsewhere]);
        expect((await sceneOf(again)).storyboard_sheets).toEqual([{ image_url: null, panels: [] }]);
    });

    it("a version names the scene too: another scene's identical shots have another version", async () => {
        const id = await project();
        const a = await sceneWith(id);
        const b = await sceneWith(id);
        fake.cloud.setShots(id, a, shots(), [sheet()]);
        fake.cloud.setShots(id, b, shots(), [sheet()]);
        const [x, y] = (await document(id)).body.scenes;
        expect(x.shots_version).not.toBe(y.shots_version);
    });

    it("puts back a version the document showed (one revision), and redo puts back the newer one; an empty set is never kept", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        const empty = (await sceneOf(id)).shots_version;
        fake.cloud.setShots(id, scene, shots(1), [sheet(1)]);
        const first = await sceneOf(id);
        fake.cloud.setShots(id, scene, shots(), [sheet()]);
        const drawn = await sceneOf(id);
        const revision = (await document(id)).body.revision;
        const undo = await change(id, { scenes: { patch: [{ id: scene, shots_version: first.shots_version }] } });
        expect(undo.status).toBe(200);
        expect(undo.body.revision).toBe(revision + 1);
        expect(undo.body.scenes[0]).toMatchObject({ storyboard_sheets: first.storyboard_sheets, shots_version: first.shots_version });
        expect(undo.body.scenes[0].shots).toHaveLength(1);
        const redo = await change(id, { scenes: { patch: [{ id: scene, shots_version: drawn.shots_version }] } });
        expect(redo.body.scenes[0]).toMatchObject({ storyboard_sheets: drawn.storyboard_sheets, shots_version: drawn.shots_version });
        expect(redo.body.scenes[0].shots).toHaveLength(2);
        // The version the scene already has changes nothing.
        expect((await change(id, { scenes: { patch: [{ id: scene, shots_version: drawn.shots_version }] } })).body.revision).toBe(redo.body.revision);
        // The empty set the scene started with was never kept: a client clears instead.
        expect((await change(id, { scenes: { patch: [{ id: scene, shots_version: empty }] } })).body.error).toMatchObject({ code: "shots_version_unknown" });
        expect((await change(id, { scenes: { patch: [{ id: scene, clear_shots: true }] } })).body.scenes[0].shots_version).toBe(empty);
    });

    it("clears a scene's shots and storyboard with clear_shots: true", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        fake.cloud.setShots(id, scene, shots(), [sheet()]);
        const cleared = await change(id, { scenes: { patch: [{ id: scene, clear_shots: true }] } });
        expect(cleared.status).toBe(200);
        expect(cleared.body.scenes[0]).toMatchObject({ shots: [], storyboard_sheets: [] });
    });

    it("refuses unknown versions (409 shots_version_unknown) and busy scenes (409 scene_busy) before anything is written", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        const revision = (await document(id)).body.revision;
        const unknown = await change(id, { scenes: { patch: [{ id: scene, caption: "x", shots_version: `sv_${"0".repeat(24)}` }] } });
        expect(unknown.status).toBe(409);
        expect(unknown.body.error).toMatchObject({ code: "shots_version_unknown", details: { kind: "scene", ids: [scene] } });
        await knob("scene-busy", { project_id: id, scene_id: scene, busy: true });
        const busy = await change(id, { scenes: { patch: [{ id: scene, clear_shots: true }] } });
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatchObject({ code: "scene_busy", details: { kind: "scene", ids: [scene] } });
        // An edit that writes no shots still saves on a busy scene.
        expect((await change(id, { scenes: { patch: [{ id: scene, caption: "Still fine" }] } })).status).toBe(200);
        await knob("scene-busy", { project_id: id, scene_id: scene, busy: false });
        expect((await change(id, { scenes: { patch: [{ id: scene, clear_shots: true }] } })).status).toBe(200);
        expect((await document(id)).body.scenes[0].caption).toBe("Still fine");
        expect((await document(id)).body.revision).toBeGreaterThan(revision);
    });

    it("refuses both fields at once, clear_shots false, a malformed version, and shot fields on a create (400)", async () => {
        const id = await project();
        const scene = await sceneWith(id);
        const version = (await sceneOf(id)).shots_version;
        for (const patch of [{ id: scene, clear_shots: true, shots_version: version }, { id: scene, clear_shots: false }, { id: scene, shots_version: "sv_nope" }]) {
            expect((await change(id, { scenes: { patch: [patch] } })).status, JSON.stringify(patch)).toBe(400);
        }
        expect((await change(id, { scenes: { create: [{ id: uuid(), clear_shots: true }] } })).status).toBe(400);
    });
});

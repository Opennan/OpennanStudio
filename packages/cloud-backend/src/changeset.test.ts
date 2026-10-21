import { buildChangesets, refusedKeys, MAX_ITEMS } from "./changeset";
import { encodeDoc, type ServerDoc } from "./codec";
import { diffDocs, emptyDelta, type Delta } from "./delta";
import { baseClip, FIXTURE_IDS, richProject } from "./fixtures";
import { urls } from "./codec.test";

const empty: ServerDoc = { revision: 0, entities: {} };
const LOCAL = "opennan-local://media/aaaaaaaa-1111-4222-8333-444444444444";

describe("buildChangesets", () => {
    it("sends creates with every column, extras_json, effects and scene order; project and tracks too", async () => {
        const target = encodeDoc(richProject(LOCAL), { urls });
        const { bodies, held, refused } = await buildChangesets(diffDocs(empty, target), target, { label: "Save", device: "MacBook" });
        expect(held).toEqual([]);
        expect(refused).toEqual([]);
        expect(bodies).toHaveLength(1);
        const body = bodies[0]!;
        expect(body).toMatchObject({ label: "Save", device: "MacBook" });
        expect(body.project).toMatchObject({ name: "Trip edit", aspect_ratio: "9:16" });
        expect(JSON.parse(body.project!.extras_json as string).tracks).toHaveLength(7);
        expect(body.tracks!.put).toContainEqual({ type: "audio", index: 2, label: "Music", muted: true, locked: false, visible: true, volume: 4 });
        const video = body.clips.create.find((c) => c.id === FIXTURE_IDS.clipVideo)!;
        expect(video).toMatchObject({ track_type: "video", track_index: 2, playback_speed: 100, volume: 4, media_url: urls.toRemote(LOCAL) });
        expect(video.effects).toEqual([
            { effect_id: "fx_blur", order: 0, enabled: true, params_json: '{"radius":4}' },
            { effect_id: "glitch", order: 1, enabled: false, params_json: null },
        ]);
        expect(JSON.parse(video.extras_json as string)).toMatchObject({ $x: { volume: 5 }, preservePitch: false });
        expect(body.scenes.create.find((s) => s.id === FIXTURE_IDS.sceneA)).toMatchObject({ order: 0, card_type: "source_clip", fit_mode: "cover" });
        expect(body.scenes.create.every((s) => !("x.order" in s))).toBe(true);
    });

    it("patches only changed columns, with the whole extras_json when an extras field changed", async () => {
        const before = encodeDoc(richProject(LOCAL), { urls });
        const edited = richProject(LOCAL);
        edited.clips[0]!.opacity = 0.5;
        edited.clips[0]!.maskJson = null;
        edited.clips[1]!.textContent = "Edited";
        const after = encodeDoc(edited, { urls, previous: before });
        const { bodies } = await buildChangesets(diffDocs(before, after), after, { label: "Edit" });
        const patches = bodies[0]!.clips.patch;
        expect(patches).toHaveLength(2);
        expect(patches[0]).toMatchObject({ id: FIXTURE_IDS.clipVideo, opacity: 0.5 });
        expect(JSON.parse(patches[0]!.extras_json as string).maskJson).toBeNull();
        expect(Object.keys(patches[0]!).sort()).toEqual(["extras_json", "id", "opacity"]);
    });

    it("holds back entities that name media not uploaded yet", async () => {
        const local = richProject("opennan-local://media/cccccccc-1111-4222-8333-444444444444");
        const target = encodeDoc(local, { urls });
        const { bodies, held } = await buildChangesets(diffDocs(empty, target), target, { label: "x" });
        expect(held.sort()).toEqual([`clip:${FIXTURE_IDS.clipAudio}`, `clip:${FIXTURE_IDS.clipVideo}`, "project", `scene:${FIXTURE_IDS.sceneA}`].sort());
        expect(bodies[0]!.clips.create.map((c) => c.id)).not.toContain(FIXTURE_IDS.clipVideo);
    });

    it("refuses what the server would refuse for sure", async () => {
        const local = richProject(LOCAL);
        local.clips.push(baseClip("not-a-uuid"), baseClip("dddddddd-1111-4222-8333-444444444444", { startTime: 5, endTime: 5 }));
        const target = encodeDoc(local, { urls });
        const { refused } = await buildChangesets(diffDocs(empty, target), target, { label: "x" });
        expect(refused.map((r) => r.key).sort()).toEqual(["clip:dddddddd-1111-4222-8333-444444444444", "clip:not-a-uuid"]);
    });

    it("splits at 500 items per list, scenes created before the clips that name them", async () => {
        const target: ServerDoc = { revision: 0, entities: {} };
        const delta: Delta = emptyDelta();
        for (let i = 0; i < 1100; i++) {
            const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
            target.entities[`clip:${id}`] = { track_type: "text", track_index: 1, start_time: i, end_time: i + 1 };
            delta.entities[`clip:${id}`] = { op: "create", fields: { start_time: { a: i } } };
        }
        const sceneId = "11111111-0000-4000-8000-000000000000";
        target.entities[`scene:${sceneId}`] = { caption: "s" };
        delta.entities[`scene:${sceneId}`] = { op: "create", fields: { caption: { a: "s" } } };
        const { bodies, keys } = await buildChangesets(delta, target, { label: "Big" });
        expect(bodies.map((b) => b.clips.create.length)).toEqual([MAX_ITEMS, MAX_ITEMS, 100]);
        expect(bodies[0]!.scenes.create[0]!.id).toBe(sceneId);
        expect(keys.flat()).toHaveLength(1101);
    });

    it("keeps a removed track when Studio kept its clips", async () => {
        const before = encodeDoc(richProject(LOCAL), { urls });
        const local = richProject(LOCAL);
        local.tracks = local.tracks.filter((t) => !(t.type === "video" && t.index === 2) && !(t.type === "remotion"));
        local.clips = local.clips.filter((c) => c.trackType !== "remotion");
        const after = encodeDoc(local, { urls, previous: before });
        const { bodies } = await buildChangesets(diffDocs(before, after), after, { label: "x" });
        expect(bodies[0]!.tracks!.removed).toEqual([{ type: "remotion", index: 1 }]);
    });
});

describe("refusedKeys", () => {
    it("reads ids and paths", () => {
        const body = { label: "", scenes: { create: [], patch: [{ id: "s1" }], delete: [] }, clips: { create: [], patch: [{ id: "c0" }, { id: "c1" }], delete: ["c9"] }, media: { add: [], remove: [] } };
        expect(refusedKeys(body, { kind: "clip", ids: ["c1"] })).toEqual(["clip:c1"]);
        expect(refusedKeys(body, { path: "clips.patch[1].end_time" })).toEqual(["clip:c1"]);
        expect(refusedKeys(body, { path: "clips.delete[0]" })).toEqual(["clip:c9"]);
        expect(refusedKeys(body, { path: "scenes.patch[0].id" })).toEqual(["scene:s1"]);
        expect(refusedKeys(body, { kind: "asset", ids: ["a1"] })).toEqual(["media:a1"]);
        expect(refusedKeys(body, undefined)).toEqual([]);
    });
});

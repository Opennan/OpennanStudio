// Real MCP transport + controller; speech generation/prices and the private library are in-memory fixtures.
import { ProviderRegistry } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, type AiRunRequest } from "@opennan/timeline-core";
import { readStoryJson } from "@opennan/story-film";
import { createControllerSession } from "../session";
import { connectInMemory } from "../testing/connect";

const STORY = { title: "Episode 1", style: "watercolour", music: "quiet piano", characters: [
    { id: "theo", name: "Theo", look: "ginger curls", voice: { providerId: "opennan", id: "vc_theo" } },
    { id: "mae", name: "Mae", look: "teal coat", voice: { providerId: "opennan", id: "vc_mae" } },
], shots: [{ id: "s1", cast: ["theo", "mae"], frame: "A rainy street", motion: "Theo waves", seconds: 5 }] };
const LINE = { id: "l1", characterId: "theo", text: "Hello.\nHow are you?", start: 0, end: 2 };
type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text?: string }> };
const textOf = (r: Result) => r.content.map(c => c.text).join(" ");

async function setup(options: { missingVoice?: boolean; failAt?: number; seconds?: number; library?: unknown[] } = {}) {
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const project = await backend.createProject({ name: "Episode", aspectRatio: "16:9" });
    const store = createEditorStore();
    const runs: AiRunRequest[] = [];
    const controller = new TimelineController({ backend, store, projectId: project.id, onAiRun: async request => {
        runs.push(request);
        if (runs.length === options.failAt) throw new Error("Test speech service temporarily failed");
        return { jobId: `j${runs.length}`, output: { costUsd: 0.01, media: [{ kind: "audio", url: `opennan-local://media/line-${runs.length}.mp3`, durationSeconds: options.seconds ?? 1.5 }] } };
    } });
    await controller.load();
    const registry = new ProviderRegistry();
    registry.register({ info: { id: "opennan", name: "OpenNan", capabilities: ["audio.tts"] },
        voices: async () => options.missingVoice ? [] : [{ id: "vc_theo", name: "Theo", language: "en" }, { id: "vc_mae", name: "Mae", language: "en" }],
        price: async () => ({ kind: "estimate", estimate: { microUsd: 10000, usd: 0.01, label: "$0.01", units: 1, capped: false } }),
    });
    const library = options.library ?? [];
    const session = createControllerSession({ controller, store, backend, providers: registry, host: { seriesLibrary: {
        list: async () => structuredClone(library), save: async cast => { const id = (cast as { id: string }).id; const i = library.findIndex(v => (v as { id: string }).id === id); if (i >= 0) library.splice(i, 1); library.push(structuredClone(cast)); },
    } } });
    const connection = await connectInMemory(session);
    const call = (name: string, args: Record<string, unknown> = {}) => connection.client.callTool({ name, arguments: args }) as Promise<Result>;
    expect((await call("story_film_create", { story: STORY })).isError).toBe(false);
    return { ...connection, call, controller, runs, library, session, story: () => readStoryJson(controller.snapshot().project?.storyFilmJson)! };
}

it("shares the cast across two client sessions and episodes without inferring speakers", async () => {
    const first = await setup(); let second: Awaited<ReturnType<typeof setup>> | undefined;
    try {
        expect((await first.call("series_cast_save", { series_id: "rain", name: "Rain" })).isError).toBe(false);
        second = await setup({ library: first.library });
        expect((await second.call("series_cast_list")).structuredContent?.series[0].characters[0].voice.id).toBe("vc_theo");
        expect((await second.call("series_cast_apply", { series_id: "rain" })).isError).toBe(false);
        expect(second.story().series?.id).toBe("rain");
        expect(textOf(await second.call("story_film_dub", { shot_id: "s1", accept_max_usd: 1 }))).toContain("unassigned");
        await second.call("story_film_set_dialogue", { shot_id: "s1", dialogue: [] });
        expect(textOf(await second.call("story_film_dub", { shot_id: "s1" }))).toContain("silent");
        expect(second.runs).toHaveLength(0);
    } finally { await first.close(); await second?.close(); }
});

it("prices before generation, uses exact saved clone ids, reuses takes and places no duplicate audio", async () => {
    const s = await setup();
    try {
        await s.call("story_film_set_dialogue", { shot_id: "s1", dialogue: [LINE] });
        const estimate = await s.call("story_film_dub", { shot_id: "s1", estimate_only: true });
        expect(estimate.structuredContent?.estimateUsd).toBe(0.01);
        expect((await s.call("story_film_dub", { shot_id: "s1" })).isError).toBe(true);
        expect(s.runs).toHaveLength(0);
        const scene = await s.controller.execute({ type: "scene.add", input: { duration: 5, afterOrder: 0 } });
        expect(scene.ok).toBe(true);
        const story = s.story(); story.assembled = { sceneIds: [s.controller.snapshot().scenes[0]!.id], clipIds: [], shotIds: ["s1"] };
        await s.controller.execute({ type: "project.update", patch: { storyFilmJson: JSON.stringify(story) } });
        const dub = await s.call("story_film_dub", { shot_id: "s1", accept_max_usd: 0.01 });
        expect(dub.isError, textOf(dub)).toBe(false);
        expect(s.runs[0]?.input).toMatchObject({ voice: "vc_theo", text: LINE.text, expectedMaxUsd: 0.01 });
        expect(s.controller.snapshot().clips).toHaveLength(1);
        expect(s.story().spentUsd).toBe(0.01);
        expect((await s.call("story_film_dub", { shot_id: "s1" })).isError).toBe(false);
        expect(s.runs).toHaveLength(1);
        expect(s.controller.snapshot().clips).toHaveLength(1);
        const result = await s.call("story_film_set_dialogue", { shot_id: "s1", dialogue: [] });
        expect(result.isError, textOf(result)).toBe(false);
        expect(s.controller.snapshot().clips).toHaveLength(0);
    } finally { await s.close(); }
});

it("refuses unavailable voices before charging and never replaces a clone with a stock voice", async () => {
    const s = await setup({ missingVoice: true });
    try {
        await s.call("story_film_set_dialogue", { shot_id: "s1", dialogue: [LINE] });
        expect(textOf(await s.call("story_film_dub", { shot_id: "s1", accept_max_usd: 1 }))).toContain("unavailable");
        expect(s.runs).toHaveLength(0);
    } finally { await s.close(); }
});

it("keeps completed takes after a partial failure and retries only missing lines", async () => {
    const s = await setup({ failAt: 2 });
    try {
        await s.call("story_film_set_dialogue", { shot_id: "s1", dialogue: [LINE, { ...LINE, id: "l2", characterId: "mae", text: "I'm listening.", start: 2, end: 5 }] });
        expect((await s.call("story_film_dub", { shot_id: "s1", accept_max_usd: 0.02 })).isError).toBe(true);
        expect(s.story().shots[0]!.dialogue![0]!.audio).toBeTruthy();
        expect(s.story().shots[0]!.dialogue![1]!.audio).toBeUndefined();
        expect((await s.call("story_film_dub", { shot_id: "s1", accept_max_usd: 0.01 })).isError).toBe(false);
        expect(s.runs).toHaveLength(3);
        expect(s.runs[2]?.input).toMatchObject({ voice: "vc_mae" });
    } finally { await s.close(); }
});

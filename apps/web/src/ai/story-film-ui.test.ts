// Story film (the AI library's Story film window): its words (no model or supplier names, every key exists), its CSS (tokens only), and the
// wizard's host on a real controller: prices first, sign-in gate, the balance check, a run that stores each file on the
// project's story as it lands, a re-run that makes nothing, cancel, drafts, and "Put on timeline".
import { en } from "@opennan/timeline-react";
import { ProviderRegistry, type PriceAnswer, type Provider } from "@opennan/provider-sdk";
import { parseStoryFilm, readStoryJson, storyJson, type StoryFilm } from "@opennan/story-film";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, type AiRunOutcome, type AiRunRequest } from "@opennan/timeline-core";
import css from "./story-film.css?raw";
import { StoryFilmSession } from "./story-film-host";

/** Model and supplier names the window's words never show (the public pages promise results, not how). */
const SECRET_WORDS = /\b(claude|sonnet|haiku|opus|anthropic|openai|gpt|gemini|grok|glm|llama|mistral|deepseek|qwen|seedream|kling|seedance|veo|sora|hailuo|nano-banana|fal\.ai|replicate)\b/i;

const SOURCES = import.meta.glob<string>("./story-*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
const MESSAGES = (en as unknown as Record<string, Record<string, string>>).storyFilm!;

const STORY = (() => {
    const parsed = parseStoryFilm({
        title: "Rain Check", style: "hand-drawn", music: "jazz waltz",
        characters: [{ id: "theo", name: "Theo", look: "ginger curls" }, { id: "mae", name: "Mae", look: "teal coat" }],
        shots: [{ id: "s01", cast: ["theo", "mae"], frame: "A street", motion: "Mae walks" }, { id: "s02", cast: ["mae"], frame: "Rain", motion: "Rain falls" }],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.story;
})();

describe("story film words and theme", () => {
    it("never names a model or supplier, and every key the components use exists", () => {
        for (const [key, text] of Object.entries(MESSAGES)) expect(`${key}: ${text}`).not.toMatch(SECRET_WORDS);
        const missing: string[] = [];
        for (const [name, code] of Object.entries(SOURCES)) {
            if (name.endsWith(".test.ts")) continue;
            expect(code.match(/"[^"]*"/g)?.filter((literal) => SECRET_WORDS.test(literal)) ?? []).toEqual([]);
            for (const [, key] of code.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) if (!(key! in MESSAGES)) missing.push(`${name}: ${key}`);
        }
        expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(3);
        expect(missing).toEqual([]);
    });

    it("uses theme tokens only", () => {
        expect(css.length).toBeGreaterThan(300);
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});

function provider(price: (capability: string) => PriceAnswer): Provider {
    return {
        info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "video.image-to-video", "audio.music", "text.generate", "web.fetch"] },
        price: async ({ capability }) => price(capability),
        models: async () => [],
    };
}

const estimate = (usd: number): PriceAnswer => ({ kind: "estimate", estimate: { microUsd: Math.round(usd * 1e6), usd, label: `≈ $${usd.toFixed(3)}`, units: 1, capped: false } });

async function setup(options: { signedIn?: boolean; balance?: number | null; reply?: string; slow?: boolean; look?: Record<string, string> } = {}) {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("p1", { meta: { id: "p1", name: "Film", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] });
    let n = 0;
    const backend = new LocalBackend({ persistence, idFactory: () => `id-${++n}` });
    const runs: AiRunRequest[] = [];
    const waiting: Array<() => void> = [];
    const onAiRun = async (request: AiRunRequest, context: { signal?: AbortSignal }): Promise<AiRunOutcome> => {
        runs.push(request);
        if (options.slow) await new Promise<void>((resolve) => waiting.push(resolve));
        if (context.signal?.aborted) return { jobId: "j", cancelled: true };
        const input = request.input as { instruction?: string; prompt?: string };
        if (request.capability === "text.generate" && input.instruction?.startsWith("Check one keyframe")) {
            // The cast check: every listed character matches unless `look` says why it does not.
            const ids = [...String(input.prompt).matchAll(/^- ([a-z0-9_-]+) \(image/gm)].map((m) => m[1]!);
            const text = JSON.stringify({ characters: ids.map((id) => ({ id, match: !options.look?.[id], reason: options.look?.[id] ?? "" })) });
            return { jobId: "j", output: { media: [], result: { text }, costUsd: 0.004 } };
        }
        if (request.capability === "text.generate") return { jobId: "j", output: { media: [], result: { text: options.reply ?? storyJson(STORY) }, costUsd: 0.01 } };
        const ext = request.capability === "image.generate" ? "png" : request.capability === "audio.music" ? "mp3" : "mp4";
        return { jobId: "j", output: { media: [{ kind: ext === "png" ? "image" : ext === "mp3" ? "audio" : "video", url: `opennan-local://media/${runs.length}.${ext}` }], costUsd: ext === "mp4" ? 0.26 : 0.05 } };
    };
    const controller = new TimelineController({ backend, store: createEditorStore(), projectId: "p1", requestTimeoutMs: 1000, onAiRun });
    await controller.load();
    const registry = new ProviderRegistry();
    registry.register(provider((capability) => estimate(capability === "video.image-to-video" ? 0.26 : capability === "text.generate" ? 0.02 : 0.05)));
    const signIns: string[] = [];
    const session = new StoryFilmSession({
        controller, providers: registry,
        requireOpenNan: async (_capability, feature) => {
            signIns.push(feature);
            return options.signedIn !== false;
        },
        account: { balance: () => (options.balance === undefined ? null : options.balance), refresh: async () => undefined },
    });
    return { session, controller, runs, signIns, release: () => waiting.splice(0).forEach((resolve) => resolve()) };
}

describe("StoryFilmSession", () => {
    it("runs a step at its price, stores each file on the project's story, and a re-run makes nothing", async () => {
        const { session, runs } = await setup();
        await session.save(STORY);
        expect((await session.estimate(STORY, "cast")).label).toBe("≈ $0.100");
        await session.run("cast", "Draw");
        const story = session.story()!;
        expect(story.characters.map((c) => c.sheet?.url)).toEqual(["opennan-local://media/1.png", "opennan-local://media/2.png"]);
        expect(story.spentUsd).toBe(0.1);
        expect(session.state().items.mae).toMatchObject({ status: "done", costUsd: 0.05 });
        await session.run("cast", "Draw");
        expect(runs).toHaveLength(2);
        expect(session.state().error).toBe("Nothing to make: everything is made.");
    });

    it("stops before anything runs when sign-in does not happen or the balance is short", async () => {
        const signedOut = await setup({ signedIn: false });
        await signedOut.session.save(STORY);
        await signedOut.session.run("cast", "Draw");
        expect(signedOut.signIns).toEqual(["Draw"]);
        expect(signedOut.runs).toHaveLength(0);
        const broke = await setup({ balance: 0.05 });
        await broke.session.save(STORY);
        await broke.session.run("cast", "Draw");
        expect(broke.runs).toHaveLength(0);
        expect(broke.session.state().error).toMatch(/^Not enough credits: this run holds up to \$0\.10/);
    });

    it("keeps text edited while a step runs, and cancel stops what is left", async () => {
        const { session, runs, release } = await setup({ slow: true });
        await session.save(STORY);
        const running = session.run("cast", "Draw");
        await vi.waitFor(() => expect(runs).toHaveLength(2));
        await session.save({ ...session.story()!, title: "Edited while drawing" });
        session.cancel();
        release();
        await running;
        const story = session.story()!;
        expect(story.title).toBe("Edited while drawing");
        expect(session.state().running).toBeNull();
    });

    it("drafts a story (replacing the old one) and puts the film on the timeline", async () => {
        const { session, controller } = await setup();
        const drafted = await session.draft({ capability: "text.generate", input: { instruction: "i", prompt: "p", maxTokens: 100 } }, { kind: "write" }, 0.02);
        expect(drafted).toBe(true);
        expect(session.story()).toMatchObject({ title: "Rain Check", spentUsd: 0.01, source: { kind: "write" } });
        const done: StoryFilm = {
            ...session.story()!,
            shots: session.story()!.shots.map((s) => ({ ...s, clip: { url: `opennan-local://media/${s.id}.mp4`, key: "k", durationSeconds: 5 } })),
        };
        await session.save(done);
        expect(await session.assemble()).toBe(true);
        const snap = controller.snapshot();
        expect(snap.project?.aspectRatio).toBe("9:16");
        expect(snap.scenes).toHaveLength(2);
        expect(readStoryJson(snap.project?.storyFilmJson)?.assembled?.sceneIds).toHaveLength(2);
        // Again: the earlier placement is replaced, never doubled.
        expect(await session.assemble()).toBe(true);
        expect(controller.snapshot().scenes).toHaveLength(2);
    });

    it("checks each keyframe's cast: priced per shot, a miss redrawn once and the shot flagged, off with the box", async () => {
        const { session, runs } = await setup({ look: { mae: "no ponytail" } });
        await session.save(STORY);
        await session.run("cast", "Draw");
        const sheeted = session.story()!;
        expect(await session.castCheckPrice(sheeted)).toMatchObject({ kind: "estimate", estimate: { label: "≈ $0.020" } });
        const off = await session.estimate(sheeted, "frames", { castCheck: 0 });
        const on = await session.estimate(sheeted, "frames", { castCheck: 1 });
        // Each shot: its keyframe and one possible redraw at $0.05, two looks at $0.02.
        expect(on.microUsd).toBe(off.microUsd * 2 + 2 * 2 * 20_000);
        await session.run("frames", "Draw", { castCheck: 1 });
        const story = session.story()!;
        // Both shots have Mae: each drawn twice, looked at twice, then kept and flagged.
        expect(runs.slice(2).map((r) => r.capability)).toEqual(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? "image.generate" : "text.generate")));
        expect(story.shots.map((s) => [s.id, s.check?.ok, s.check?.tries])).toEqual([["s01", false, 2], ["s02", false, 2]]);
        expect(session.state().error).toBeNull();
        const before = runs.length;
        await session.run("frames", "Draw", { only: ["s02"], redo: true, castCheck: 0 });
        expect(runs.slice(before).map((r) => r.capability)).toEqual(["image.generate"]);
        expect(session.story()!.shots[1]!.check).toBeUndefined();
    });

    it("shows a draft that does not read as a story, and keeps the old story", async () => {
        const { session } = await setup({ reply: "No." });
        await session.save(STORY);
        expect(await session.draft({ capability: "text.generate", input: { instruction: "i", prompt: "p", maxTokens: 100 } }, { kind: "write" }, 0.02)).toBe(false);
        expect(session.state().draftErrors).toEqual(["the story writer's answer had no story in it"]);
        expect(session.story()?.title).toBe("Rain Check");
    });
});

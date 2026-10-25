// Phase 9b: OpenNan project pipeline tools on the host's pipeline seam (StudioSession.pipelines): scene by order or id,
// OpenNan's quote first (accept_max_usd refuses before anything is submitted, dry_run answers the quote only), then
// the task's end with its charge and project revision; hosts without the seam (every current one) answer unavailable.
import { getTool, PROJECT_PIPELINE_TOOLS } from "@opennan/mcp-schema";
import type { StudioPipelineQuote, StudioPipelineResult, StudioProjectPipelines, StudioSession } from "../session";
import { toolCallHistory } from "../tool-calls";
import { NO_PIPELINES, PIPELINE_HANDLERS, PRICE_UNAVAILABLE } from "./pipelines";

const SCENES = [
    { id: "s-b", order: 1, caption: "", duration: 4 },
    { id: "s-a", order: 0, caption: "", duration: 3 },
];

const SUCCEEDED: StudioPipelineResult = { taskId: "task_1", status: "succeeded", chargedUsd: 0.31, projectRevision: 7, synced: true, undoable: true, error: null };

function fakePipelines(quote: StudioPipelineQuote = { kind: "quote", priceUsd: 0.31, holdUsd: 0.31 }, result: StudioPipelineResult = SUCCEEDED) {
    return {
        quote: vi.fn(async () => quote),
        run: vi.fn(async () => result),
        editScene: vi.fn(async () => ({ synced: true })),
        setScript: vi.fn(async () => undefined),
    } satisfies StudioProjectPipelines;
}

function context(options: { pipelines?: StudioProjectPipelines } = {}) {
    const session = {
        projectId: "p1",
        host: {},
        snapshot: async () => ({ projectId: "p1", tracks: [], clips: [], scenes: SCENES }),
        ...(options.pipelines ? { pipelines: options.pipelines } : {}),
    } as unknown as StudioSession;
    return (name: string) => ({ session, tool: getTool(name)!, history: toolCallHistory(session), signal: new AbortController().signal });
}

const call = (name: string, args: Record<string, unknown>, ctx: ReturnType<typeof context>) => PIPELINE_HANDLERS[name]!(args, ctx(name));

describe("project pipeline tools", () => {
    it("has a handler for every project pipeline tool", () => {
        expect(Object.keys(PIPELINE_HANDLERS).sort()).toEqual([...PROJECT_PIPELINE_TOOLS].sort());
    });

    it("answer unavailable on hosts without project pipelines (every current host)", async () => {
        const ctx = context();
        for (const name of PROJECT_PIPELINE_TOOLS) {
            const outcome = await call(name, { scene_order: 1 }, ctx);
            expect(outcome, name).toMatchObject({ ok: false, text: NO_PIPELINES, unavailable: { reason: NO_PIPELINES } });
            expect(outcome.unavailable?.capability, name).toBe(getTool(name)!.capability);
        }
    });

    it("refuse before submitting when OpenNan's quote is above accept_max_usd", async () => {
        const pipelines = fakePipelines({ kind: "quote", priceUsd: 0.31, holdUsd: 0.4 });
        const outcome = await call("generate_storyboard", { scene_order: 2, accept_max_usd: 0.35 }, context({ pipelines }));
        expect(pipelines.run).not.toHaveBeenCalled();
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain("OpenNan quotes ≈ $0.31");
        expect(outcome.text).toContain("$0.35");
        expect(outcome.text).toMatch(/nothing ran/i);
        expect(outcome.data).toMatchObject({ quoted: true, priceUsd: 0.31, holdUsd: 0.4, acceptMaxUsd: 0.35, submitted: false });
    });

    it("refuse without a quote: prices are never estimated locally", async () => {
        const pipelines = fakePipelines({ kind: "unavailable" });
        const outcome = await call("detect_copy_video_shots", { scene_order: 1 }, context({ pipelines }));
        expect(outcome).toMatchObject({ ok: false, text: PRICE_UNAVAILABLE });
        expect(PRICE_UNAVAILABLE).toBe("OpenNan can't price this right now, so it didn't run.");
        expect(pipelines.run).not.toHaveBeenCalled();
        const refused = fakePipelines({ kind: "refused", code: "invalid_request", message: "This scene already has a storyboard." });
        const answer = await call("generate_storyboard", { scene_order: 1 }, context({ pipelines: refused }));
        expect(answer).toMatchObject({ ok: false, text: expect.stringContaining("This scene already has a storyboard.") });
        expect(refused.run).not.toHaveBeenCalled();
    });

    it("dry_run answers the quote only", async () => {
        const pipelines = fakePipelines({ kind: "quote", priceUsd: 0.5, holdUsd: 0.5 });
        const outcome = await call("generate_scene_videos_smart", { scene_id: "s-a", model_id: "kling-o3", dry_run: true }, context({ pipelines }));
        expect(pipelines.quote).toHaveBeenCalledWith({ tool: "smart-scene-video", sceneId: "s-a", body: { model: "kling-o3" }, label: "Video of scene 1" });
        expect(pipelines.run).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ ok: true, data: { quoted: true, priceUsd: 0.5, holdUsd: 0.5, dryRun: true, submitted: false } });
        expect(outcome.text).toContain("OpenNan quotes ≈ $0.50");
    });

    it("runs a step and reports its charge and project revision", async () => {
        const pipelines = fakePipelines();
        const outcome = await call("generate_storyboard", { scene_order: 2, regenerate: true, accept_max_usd: 1 }, context({ pipelines }));
        const step = { tool: "storyboard", sceneId: "s-b", body: { regenerate: true }, label: "Storyboard of scene 2" };
        expect(pipelines.quote).toHaveBeenCalledWith(step);
        expect(pipelines.run).toHaveBeenCalledWith(step, expect.objectContaining({ maxHoldUsd: 1 }));
        expect(outcome).toMatchObject({
            ok: true,
            data: { quoted: true, priceUsd: 0.31, holdUsd: 0.31, submitted: true, taskId: "task_1", status: "succeeded", chargedUsd: 0.31, projectRevision: 7, synced: true, undoable: true },
        });
        expect(outcome.text).toContain("OpenNan quotes ≈ $0.31");
        expect(outcome.text).toContain("charged $0.31");
        expect(outcome.text).toContain("undo_last_edit");
    });

    it("reports a failed task with its refund", async () => {
        const pipelines = fakePipelines(undefined, { ...SUCCEEDED, status: "failed", chargedUsd: null, projectRevision: null, synced: false, undoable: false, error: { message: "Drawing failed.", code: "upstream", refunded: true } });
        const outcome = await call("generate_video_from_panels", { scene_order: 1 }, context({ pipelines }));
        expect(pipelines.run).toHaveBeenCalledWith({ tool: "copy-video-recreate", sceneId: "s-a", body: {}, label: "Video from the panels of scene 1" }, expect.anything());
        // Without accept_max_usd the run is still held to the quote this answer reports.
        expect((pipelines.run.mock.calls[0] as unknown[])[1]).toMatchObject({ maxHoldUsd: expect.any(Number) });
        expect(outcome).toMatchObject({ ok: false, data: { quoted: true, status: "failed", submitted: true } });
        expect(outcome.text).toContain("Drawing failed.");
        expect(outcome.text).toMatch(/refunded/);
    });

    it("turns a refused submit into a failure with OpenNan's message", async () => {
        const pipelines = fakePipelines();
        pipelines.run.mockRejectedValueOnce(new Error("Not enough credits."));
        const outcome = await call("generate_storyboard", { scene_order: 1 }, context({ pipelines }));
        expect(outcome).toMatchObject({ ok: false, text: expect.stringContaining("Not enough credits.") });
    });

    it("resolves the scene by 1-based order or by id, and refuses unknown or mismatched scenes", async () => {
        const pipelines = fakePipelines();
        const ctx = context({ pipelines });
        await call("detect_copy_video_shots", { scene_order: 1 }, ctx);
        expect(pipelines.run).toHaveBeenLastCalledWith(expect.objectContaining({ tool: "copy-video-detect", sceneId: "s-a", label: "Shots of the copied video in scene 1" }), expect.anything());
        await call("edit_copy_video_shot_image", { scene_id: "s-b", shot_index: 2, instruction: "Make it night" }, ctx);
        expect(pipelines.run).toHaveBeenLastCalledWith({ tool: "copy-video-edit", sceneId: "s-b", index: 2, body: { instruction: "Make it night" }, label: "Panel of shot 3 in scene 2" }, expect.anything());
        expect(await call("generate_storyboard", { scene_order: 3 }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("Scene 3 not found") });
        expect(await call("generate_storyboard", { scene_id: "nope" }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("nope") });
        expect(await call("generate_storyboard", { scene_id: "s-a", scene_order: 2 }, ctx)).toMatchObject({ ok: false });
        expect(await call("generate_storyboard", {}, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("scene_order") });
        expect(await call("edit_copy_video_shot_image", { scene_order: 1, shot_index: -1, instruction: "x" }, ctx)).toMatchObject({ ok: false });
        expect(await call("generate_storyboard", { scene_order: 1, accept_max_usd: -1 }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("accept_max_usd") });
        expect(pipelines.run).toHaveBeenCalledTimes(2);
    });

    it("plans scenes from the stored script, quoted the same way", async () => {
        const pipelines = fakePipelines({ kind: "quote", priceUsd: 0.2, holdUsd: 0.2 });
        const ctx = context({ pipelines });
        const dry = await call("plan_scenes", { style: "Watercolor", dry_run: true }, ctx);
        expect(pipelines.quote).toHaveBeenCalledWith({ tool: "story-scenes", body: { style: "Watercolor" }, label: "Scene plan" });
        expect(dry).toMatchObject({ ok: true, data: { dryRun: true, priceUsd: 0.2 } });
        expect(await call("plan_scenes", { accept_max_usd: 0.1 }, ctx)).toMatchObject({ ok: false, data: { submitted: false } });
        expect(pipelines.run).not.toHaveBeenCalled();
        const ran = await call("plan_scenes", { concept: "A trip", direction: "Warm" }, ctx);
        expect(pipelines.run).toHaveBeenCalledWith({ tool: "story-scenes", body: { concept: "A trip", direction: "Warm" }, label: "Scene plan" }, expect.anything());
        expect(ran).toMatchObject({ ok: true, data: { status: "succeeded", projectRevision: 7 } });
    });

    it("sets the copy-video source and a shot's words without a quote", async () => {
        const pipelines = fakePipelines();
        const ctx = context({ pipelines });
        const source = await call("set_copy_video_source", { scene_order: 2, video_url: "https://cdn.example.com/v.mp4", trim_start: 1, trim_end: 9 }, ctx);
        expect(pipelines.editScene).toHaveBeenCalledWith({ kind: "copy-video-source", sceneId: "s-b", videoUrl: "https://cdn.example.com/v.mp4", trimStart: 1, trimEnd: 9 });
        expect(source).toMatchObject({ ok: true, data: { sceneId: "s-b", synced: true } });
        const text = await call("edit_copy_video_shot_description", { scene_id: "s-a", shot_index: 0, description: "A dog runs" }, ctx);
        expect(pipelines.editScene).toHaveBeenLastCalledWith({ kind: "shot-text", sceneId: "s-a", index: 0, action: "A dog runs" });
        expect(text).toMatchObject({ ok: true });
        expect(pipelines.quote).not.toHaveBeenCalled();
        expect(await call("set_copy_video_source", { scene_order: 1, video_url: "http://x/v.mp4" }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("https") });
        expect(await call("set_copy_video_source", { scene_order: 1, video_url: "https://x/v.mp4", trim_start: 5, trim_end: 2 }, ctx)).toMatchObject({ ok: false });
        expect(await call("edit_copy_video_shot_description", { scene_order: 1, shot_index: 0, description: "  " }, ctx)).toMatchObject({ ok: false });
        expect(pipelines.editScene).toHaveBeenCalledTimes(2);
    });

    it("stores the script: at least one field, strings or null", async () => {
        const pipelines = fakePipelines();
        const ctx = context({ pipelines });
        expect(await call("set_project_script", {}, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("script_text") });
        expect(await call("set_project_script", { script_text: 3 }, ctx)).toMatchObject({ ok: false });
        expect(await call("set_project_script", { script_text: "x".repeat(20_001) }, ctx)).toMatchObject({ ok: false });
        expect(await call("set_project_script", { srt_content: "x".repeat(200_001) }, ctx)).toMatchObject({ ok: false });
        expect(pipelines.setScript).not.toHaveBeenCalled();
        const stored = await call("set_project_script", { script_text: "Hello there.", srt_content: null }, ctx);
        expect(pipelines.setScript).toHaveBeenCalledWith({ scriptText: "Hello there.", srtContent: null });
        expect(stored).toMatchObject({ ok: true });
        expect(stored.text).toMatch(/plan_scenes/);
        pipelines.setScript.mockRejectedValueOnce(new Error("srt_content: not a valid SRT file"));
        expect(await call("set_project_script", { srt_content: "nope" }, ctx)).toMatchObject({ ok: false, text: "srt_content: not a valid SRT file" });
    });
});

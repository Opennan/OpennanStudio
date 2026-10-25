import { checkPipelineRequest, pipelineRequest, projectVideoModels, quoteBodyOf, videoQualities } from "./director-pipelines";

describe("checkPipelineRequest", () => {
    it("lets through the pipeline routes of this project with their own fields", () => {
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s-1/storyboard", body: { model: "auto" } }))
            .toEqual({ method: "POST", path: "/v1/projects/p1/scenes/s-1/storyboard", body: { model: "auto" }, tool: "storyboard", projectId: "p1", sceneId: "s-1" });
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/story/plan", body: { style: "noir" } })).toMatchObject({ tool: "story-scenes" });
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s1/shots/3/image-edits", body: { instruction: "brighter" } })).toMatchObject({ tool: "copy-video-edit", index: 3 });
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s1/videos" })).toMatchObject({ tool: "smart-scene-video", body: {} });
    });

    it("refuses another project, another route, another method, unknown fields, odd bodies", () => {
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p2/scenes/s1/storyboard", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/exports", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/changes", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "DELETE", path: "/v1/projects/p1/scenes/s1/storyboard", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "https://evil.test/v1/projects/p1/story/plan", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/../storyboard", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard?x=1", body: {} })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", body: { callback_url: "https://evil.test" } })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", body: [] })).toBeNull();
        expect(checkPipelineRequest("p1", { method: "POST", path: "/v1/projects/p1/story/plan", body: { style: "x".repeat(20_000) } })).toBeNull();
        expect(checkPipelineRequest("p1", null)).toBeNull();
    });
});

describe("pipelineRequest and quotes", () => {
    it("builds a step's request and its quote body", () => {
        const request = pipelineRequest("smart-scene-video", "p1", { sceneId: "s1", body: { quality: "720p" } });
        expect(request.path).toBe("/v1/projects/p1/scenes/s1/videos");
        expect(quoteBodyOf(request)).toEqual({ tool: "smart-scene-video", project_id: "p1", scene_id: "s1", inputs: { quality: "720p" } });
        expect(quoteBodyOf(pipelineRequest("story-scenes", "p1"))).toEqual({ tool: "story-scenes", project_id: "p1" });
        expect(quoteBodyOf(pipelineRequest("copy-video-edit", "p1", { sceneId: "s1", index: 2, body: { instruction: "x" } }))).toEqual({ tool: "copy-video-edit", project_id: "p1", scene_id: "s1", index: 2, inputs: { instruction: "x" } });
    });

    it("lists the route's video models and their qualities", () => {
        expect(projectVideoModels("smart-scene-video")).toEqual(["auto", "seedance-2", "kling-o3", "kling-3"]);
        expect(projectVideoModels("storyboard")).toEqual(["auto", "seedance-2", "kling-o3"]);
        expect(videoQualities("auto")).toEqual(["480p", "720p", "1080p"]);
        expect(videoQualities("kling-3")).toEqual(["720p", "1080p"]);
    });
});

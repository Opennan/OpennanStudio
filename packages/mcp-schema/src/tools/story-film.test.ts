import { STUDIO_TOOLS, getTool } from "../registry";
import { STORY_FILM_TOOLS } from "./story-film";

describe("story film tools", () => {
    it("lists the nine tools, in the order an agent calls them", () => {
        expect(STORY_FILM_TOOLS.map((t) => t.name)).toEqual([
            "story_film_get", "story_film_create", "story_film_copy", "story_film_cast", "story_film_frames", "story_film_animate", "story_film_music",
            "story_film_assemble", "apply_reel_layout",
        ]);
        for (const tool of STORY_FILM_TOOLS) expect(STUDIO_TOOLS).toContain(tool);
    });

    it("prices its paid steps first: estimate_only and accept_max_usd on each", () => {
        for (const name of ["story_film_copy", "story_film_cast", "story_film_frames", "story_film_animate", "story_film_music"]) {
            const tool = getTool(name)!;
            expect(tool.kind).toBe("capability");
            expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["estimate_only", "accept_max_usd"]));
        }
        expect(getTool("story_film_animate")!.capability).toBe("video.image-to-video");
        expect(getTool("story_film_get")!.readOnly).toBe(true);
    });

    it("never names a supplier", () => {
        const text = JSON.stringify(STORY_FILM_TOOLS);
        expect(text).not.toMatch(/gemini|seedream|fal\.ai/i);
    });
});

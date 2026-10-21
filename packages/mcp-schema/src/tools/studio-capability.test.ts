import Ajv from "ajv";
import { isToolCapability } from "../capabilities";
import { STUDIO_CAPABILITY_TOOLS } from "./studio-capability";

const byName = (name: string) => {
    const tool = STUDIO_CAPABILITY_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return tool;
};
const valid = (name: string, args: unknown) => new Ajv({ strict: false }).compile(byName(name).inputSchema)(args);

describe("studio capability tools", () => {
    it("need a known capability, are studio additions, and compile", () => {
        const ajv = new Ajv({ strict: false });
        expect(STUDIO_CAPABILITY_TOOLS.map((tool) => tool.name)).toEqual([
            "auto_captions", "translate_captions", "isolate_voice", "upscale_video", "remove_video_background", "lipsync_clip", "split_vocals", "stabilize_clip",
        ]);
        for (const tool of STUDIO_CAPABILITY_TOOLS) {
            expect(tool.kind, tool.name).toBe("capability");
            expect(tool.origin, tool.name).toBe("studio");
            expect(tool.commands, tool.name).toEqual(["ai.run"]);
            expect(tool.readOnly, tool.name).toBe(false);
            expect(isToolCapability(tool.capability ?? ""), tool.name).toBe(true);
            expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
            expect(tool.description.length, tool.name).toBeLessThanOrEqual(200);
            expect(tool.description, tool.name).not.toMatch(/\b(you|must|never|always|paid|free)\b/i);
        }
    });

    it("auto_captions takes an optional clip or scene, language, model, style, and engine", () => {
        const tool = byName("auto_captions");
        expect(valid("auto_captions", {})).toBe(true);
        expect(valid("auto_captions", { language: "en", model: "tiny", style: "subtitle", engine: "cloud" })).toBe(true);
        expect(valid("auto_captions", { clip_id: "a", engine: "local" })).toBe(true);
        expect(valid("auto_captions", { style: "karaoke" })).toBe(false);
        expect(valid("auto_captions", { engine: "gpu" })).toBe(false);
        expect(valid("auto_captions", { extra: 1 })).toBe(false);
        expect(tool.capability).toBe("audio.transcribe");
    });

    it("route each media tool to its capability", () => {
        const capability = (name: string) => byName(name).capability;
        expect(capability("translate_captions")).toBe("captions.translate");
        expect(capability("isolate_voice")).toBe("audio.isolate-voice");
        expect(capability("upscale_video")).toBe("video.upscale");
        expect(capability("remove_video_background")).toBe("video.remove-background");
        expect(capability("lipsync_clip")).toBe("video.lipsync");
        expect(capability("split_vocals")).toBe("audio.separate");
        expect(capability("stabilize_clip")).toBe("media.stabilize");
    });

    it("take a clip or a scene as two optional ids (the handler checks that one is given)", () => {
        for (const name of ["isolate_voice", "upscale_video", "remove_video_background", "split_vocals", "stabilize_clip"]) {
            const schema = byName(name).inputSchema;
            expect(Object.keys(schema.properties), name).toEqual(expect.arrayContaining(["clip_id", "scene_id"]));
            expect(schema.required ?? [], name).not.toContain("clip_id");
            expect(schema.required ?? [], name).not.toContain("scene_id");
        }
        expect(valid("isolate_voice", { clip_id: "a" })).toBe(true);
        expect(valid("isolate_voice", { scene_id: "s", first_seconds: 30 })).toBe(true);
        expect(valid("isolate_voice", { scene_id: "s", first_seconds: 0 })).toBe(false);
        expect(valid("stabilize_clip", { clip_id: "a", first_seconds: 5 })).toBe(false);
    });

    it("validate each tool's own choices", () => {
        expect(valid("translate_captions", { track_index: 1, language: "th" })).toBe(true);
        expect(valid("translate_captions", { clip_id: "c", language: "ja", keep_source: false })).toBe(true);
        expect(valid("translate_captions", { track_index: 1 })).toBe(false);
        expect(byName("translate_captions").inputSchema.required).toEqual(["language"]);
        expect(valid("upscale_video", { clip_id: "v", resolution: "4k" })).toBe(true);
        expect(valid("upscale_video", { clip_id: "v", resolution: "8k" })).toBe(false);
        expect(byName("upscale_video").inputSchema.required).toEqual(["resolution"]);
        expect(valid("remove_video_background", { clip_id: "v", background: "green" })).toBe(true);
        expect(valid("remove_video_background", { clip_id: "v", background: "red" })).toBe(false);
        expect(valid("lipsync_clip", { clip_id: "v", audio_clip_id: "a", first_seconds: 10 })).toBe(true);
        expect(valid("lipsync_clip", { clip_id: "v" })).toBe(false);
        expect(valid("split_vocals", { clip_id: "a", stems: "all" })).toBe(true);
        expect(valid("split_vocals", { clip_id: "a", stems: "drums" })).toBe(false);
    });
});

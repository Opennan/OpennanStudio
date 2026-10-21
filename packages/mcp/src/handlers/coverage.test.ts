// Spec §5.11: CI fails when a tool in @opennan/mcp-schema has no handler, and
// every offline tool has a round-trip case against LocalBackend.
import { EDITOR_TOOLS, STUDIO_TOOLS } from "@opennan/mcp-schema";
import { ANALYSIS_CASES } from "../testing/cases/analysis";
import { CLIP_CASES } from "../testing/cases/clips";
import { EDITOR_CASES } from "../testing/cases/editor";
import { LOOK_CASES } from "../testing/cases/looks";
import { MEDIA_CASES } from "../testing/cases/media";
import { MOTION_CASES } from "../testing/cases/motion";
import { READ_CASES } from "../testing/cases/read";
import { SCENE_CASES } from "../testing/cases/scenes";
import { TRACKING_CASES } from "../testing/cases/tracking";
import { TOOL_HANDLERS } from "./index";

describe("handler coverage", () => {
    it("has a handler for every schema tool", () => {
        expect(STUDIO_TOOLS.map((tool) => tool.name).filter((name) => !TOOL_HANDLERS[name])).toEqual([]);
    });

    it("has no handler without a schema tool", () => {
        const names = new Set(STUDIO_TOOLS.map((tool) => tool.name));
        expect(Object.keys(TOOL_HANDLERS).filter((name) => !names.has(name))).toEqual([]);
    });

    it("has a round-trip case for every offline tool", () => {
        const cases = Object.keys({ ...READ_CASES, ...CLIP_CASES, ...MEDIA_CASES, ...SCENE_CASES, ...EDITOR_CASES, ...LOOK_CASES, ...MOTION_CASES, ...TRACKING_CASES, ...ANALYSIS_CASES }).sort();
        expect(cases).toEqual(EDITOR_TOOLS.map((tool) => tool.name).sort());
    });
});

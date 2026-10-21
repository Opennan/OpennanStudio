import { createFixtureStudio } from "../testing/fixture";
import { LOOK_CASES } from "../testing/cases/looks";
import { roundTrip } from "../testing/roundtrip";
import { LOOK_HANDLERS } from "./looks";
import { MOTION_HANDLERS } from "./motion";
import type { ToolContext } from "./types";

describe("phase 10c tool validation (callers that skip the schema)", () => {
    const contextFor = async (name: string) => {
        const studio = await createFixtureStudio();
        return { studio, context: { session: studio.session, tool: { name } } as unknown as ToolContext };
    };

    it("set_mask refuses fields outside the mask model's ranges and unknown shapes", async () => {
        const { studio, context } = await contextFor("set_mask");
        const call = (args: Record<string, unknown>) => LOOK_HANDLERS.set_mask({ scene_order: 1, shape: "circle", ...args }, context);
        for (const [arg, value, range] of [
            ["x", 3.5, "-2 to 3"], ["y", -2.5, "-2 to 3"], ["width", 0, "0.01 to 5"], ["height", 6, "0.01 to 5"],
            ["rotation", 3601, "-3600 to 3600"], ["feather", -0.1, "0 to 1"], ["roundness", 2, "0 to 1"], ["feather", "soft", "0 to 1"],
        ] as const) {
            const outcome = await call({ [arg]: value });
            expect(outcome.ok, `${arg}=${value}`).toBe(false);
            expect(outcome.text, arg).toBe(`${arg} must be a number from ${range}.`);
        }
        expect((await call({ invert: "yes" })).text).toBe("invert must be true or false.");
        expect((await call({ shape: "triangle" })).text).toMatch(/shape must be one of none, linear/);
        expect((await call({ time: "now" })).text).toMatch(/time must be a number/);
        expect(studio.controller.snapshot().scenes.every((s) => !s.maskJson)).toBe(true);
        expect((await call({ x: 3, feather: 1, rotation: -3600 })).ok).toBe(true);
    });

    it("paste_attributes refuses unknown or empty kind lists", async () => {
        const { context } = await contextFor("paste_attributes");
        const call = (attributes: unknown) => LOOK_HANDLERS.paste_attributes({ source_scene_order: 1, scene_orders: [2], attributes }, context);
        expect((await call(["colour"])).text).toBe("attributes must list kinds from filter, adjust, effects, animation, speed, mask, transform.");
        expect((await call([])).ok).toBe(false);
        expect((await call("filter")).ok).toBe(false);
    });

    it("retime_keyframe and set_speed check their arguments before running a command", async () => {
        const { studio, context } = await contextFor("retime_keyframe");
        await studio.controller.execute({ type: "keyframe.set", sceneId: "s1", time: 1, values: { scale: 2 } });
        const retime = (args: Record<string, unknown>) => MOTION_HANDLERS.retime_keyframe({ scene_order: 1, from: 1, to: 2, ...args }, context);
        expect((await retime({ to: "2" })).text).toBe("from and to must be numbers of item-local seconds.");
        expect((await retime({ channels: [] })).text).toMatch(/channels must be a non-empty list/);
        expect((await retime({ values: [1] })).text).toMatch(/values must be an object/);
        expect((await retime({ values: { wobble: 1 } })).text).toMatch(/unknown keyframe channel or value "wobble"/);
        const speed = (args: Record<string, unknown>) => MOTION_HANDLERS.set_speed({ speed: 2, ...args }, { ...context, tool: { name: "set_speed" } } as ToolContext);
        expect((await speed({ clip_ids: [] })).text).toBe("clip_ids must list at least one clip.");
        expect((await speed({ clip_ids: ["music"], scene_order: 1 })).text).toMatch(/clip_ids, clip_id, or scene_order/);
    });
});

roundTrip("transition, filter, adjustment, effect-order, mask, and paste-attributes tools round-trip", LOOK_CASES);

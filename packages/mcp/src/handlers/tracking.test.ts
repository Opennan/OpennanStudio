import { connectInMemory } from "../testing/connect";
import { createFixtureStudio } from "../testing/fixture";
import { TRACKING_CASES } from "../testing/cases/tracking";
import { roundTrip } from "../testing/roundtrip";

describe("track_motion without a motion tracker", () => {
    it("answers unavailable (headless hosts cannot decode video) and changes nothing", async () => {
        const studio = await createFixtureStudio();
        const { client, close } = await connectInMemory(studio.session);
        try {
            const result = await client.callTool({ name: "track_motion", arguments: { scene_order: 1, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, follower_clip_ids: ["title"] } });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ ok: false, unavailable: true, reason: expect.stringMatching(/decode video/) });
            expect(studio.controller.snapshot().clips.find((c) => c.id === "title")?.keyframesJson ?? null).toBeNull();
        } finally {
            await close();
        }
    });
});

roundTrip("track_motion round-trips", TRACKING_CASES);

import { connectInMemory } from "../testing/connect";
import { ANALYSIS_CASES } from "../testing/cases/analysis";
import { createFixtureStudio } from "../testing/fixture";
import { roundTrip } from "../testing/roundtrip";

roundTrip("local AI tools round-trip", ANALYSIS_CASES);

describe("local AI tools without an audio decoder (headless without --ffmpeg)", () => {
    it("answer silences and beats as unavailable with the reason", async () => {
        const studio = await createFixtureStudio();
        const { client, close } = await connectInMemory(studio.session);
        try {
            for (const [name, args] of [["remove_silences", { clip_id: "music" }], ["detect_beats", { clip_id: "music" }]] as const) {
                const result = await client.callTool({ name, arguments: args });
                expect(result.isError, name).toBe(true);
                expect(result.structuredContent, name).toMatchObject({
                    unavailable: true,
                    reason: `${name} needs an audio decoder: the OpenNan Studio editor window (desktop or web), or \`opennan-studio mcp serve\` started with --ffmpeg.`,
                });
            }
            const music = studio.controller.snapshot().clips.find((c) => c.id === "music");
            expect(music).toMatchObject({ startTime: 0, endTime: 15 });
            expect(music?.beatsJson ?? null).toBeNull();
        } finally {
            await close();
        }
    });
});

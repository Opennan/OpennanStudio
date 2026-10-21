// Round-trip harness: each case calls tools through the MCP SDK client against
// the fixture project on LocalBackend, then checks the controller state.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectInMemory } from "./connect";
import { createStubExportRunner } from "./export-runner";
import { createFakeAnalyzer, createFakeMotionTracker, createFixtureStudio, type FixtureStudio } from "./fixture";

export type Call = (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
export type Case = (call: Call, studio: FixtureStudio) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into structured results
export const data = (result: CallToolResult) => result.structuredContent as Record<string, any>;
export const text = (result: CallToolResult) => (result.content[0] as { text: string }).text;
export const clipOf = (studio: FixtureStudio, id: string) => studio.controller.snapshot().clips.find((c) => c.id === id);
export const scenesOf = (studio: FixtureStudio) => [...studio.controller.snapshot().scenes].sort((a, b) => a.order - b.order);
export const shotsOf = (studio: FixtureStudio, sceneIndex: number) => JSON.parse(scenesOf(studio)[sceneIndex].shotBreakdown || "[]");

export const PNG = { mimeType: "image/png" as const, data: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1 };

/** Registers one `it` per case, each on a fresh fixture with a full fake host and the stand-in export runner. */
export function roundTrip(title: string, cases: Record<string, Case>): void {
    describe(title, () => {
        let studio: FixtureStudio;
        let close: () => Promise<void>;
        let call: Call;

        beforeEach(async () => {
            let panel: string | null = null;
            studio = await createFixtureStudio({
                frameRenderer: { renderFrame: async () => PNG },
                exportRunner: createStubExportRunner(),
                motionTracker: createFakeMotionTracker(),
                analyzer: createFakeAnalyzer(),
                host: {
                    openPanel: async (name) => {
                        panel = name;
                    },
                    activePanel: () => panel,
                    snapshotPage: async () => PNG,
                    readFile: async (path, kind) => new File([new Uint8Array([1, 2, 3, 4])], path, { type: kind === "audio" ? "audio/wav" : "video/mp4" }),
                    graphicsTemplateIds: async () => ["lower-third"],
                },
            });
            const connected = await connectInMemory(studio.session);
            close = connected.close;
            call = async (name, args = {}) => (await connected.client.callTool({ name, arguments: args })) as CallToolResult;
        });

        afterEach(async () => {
            await close();
        });

        for (const [name, run] of Object.entries(cases)) {
            it(name, async () => {
                await run(call, studio);
            });
        }
    });
}

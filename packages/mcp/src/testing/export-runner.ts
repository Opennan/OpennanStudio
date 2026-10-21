// A stand-in ExportRunner: the real @opennan/export pipeline (probe -> compile ->
// encoder -> run) runs against it without ffmpeg.
import type { EncoderChoice, ExportPlan, ExportRunner } from "@opennan/export";

export const STUB_EXPORT_PATH = "/exports/fixture.mp4";

const ENCODER: EncoderChoice = { name: "libopenh264", container: "mp4", gpl: false, globalArgs: [], videoFilters: [], videoArgs: [], audioArgs: [] };

export interface StubExportRunner extends ExportRunner {
    probed: string[];
    plans: ExportPlan[];
    frames: Array<{ seconds: number; size?: { width: number; height: number } }>;
    /** While set, run() waits for it (tests of a running export). */
    hold: Promise<void> | null;
}

export function createStubExportRunner(): StubExportRunner {
    const runner: StubExportRunner = {
        kind: "node",
        supportsGl: false,
        maxResolution: "1080p",
        probed: [],
        plans: [],
        frames: [],
        hold: null,
        async probe(urls) {
            runner.probed.push(...urls);
            return new Map();
        },
        async chooseEncoder() {
            return ENCODER;
        },
        async run(plan) {
            runner.plans.push(plan);
            if (runner.hold) await runner.hold;
            return { kind: "file", path: STUB_EXPORT_PATH };
        },
        async renderFrame(_plan, seconds, options) {
            runner.frames.push({ seconds, size: options?.size });
            return new Uint8Array([137, 80, 78, 71]);
        },
    };
    return runner;
}

// Text state atlases (phase 10b): the compiled per-frame crop picks, at every output frame, the very state
// the preview draws (textStateAt at the same item-local time), on native ffmpeg and ffmpeg.wasm.
import { describe, expect, it } from "vitest";
import { evaluateScalar } from "@opennan/timeline-core/looks/expr";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { atlasLayout, textStateAt, textStatePlan } from "@opennan/timeline-core/text/text-states";
import { compileExport } from "../src/compile";
import { clip as makeClip, input } from "../src/compile/test-helpers";
import type { RasterResult } from "../src/types";
import { ffmpegHosts } from "./ffmpeg";
import { runFilter, splitFrames } from "./frames";

const hosts = await ffmpegHosts();
const FPS = 30;
const SECONDS = 2;
const START = 0.4;
// One cell is the padded box of a 24 × 16 text box with 4 px of bleed: 32 × 24, drawn at scale 1.
const BOX = { width: 24, height: 16, pad: 4 };
const CELL = { width: BOX.width + BOX.pad * 2, height: BOX.height + BOX.pad * 2 };
const level = (index: number) => 20 + 26 * index;

/** An RGBA atlas whose cell i is solid gray level(i). */
function atlasPng(count: number) {
    const layout = atlasLayout(count, CELL.width, CELL.height);
    const data = new Uint8Array(layout.width * layout.height * 4);
    for (let y = 0; y < layout.height; y += 1) {
        for (let x = 0; x < layout.width; x += 1) {
            const index = Math.floor(y / layout.cellHeight) * layout.cols + Math.floor(x / layout.cellWidth);
            const o = (y * layout.width + x) * 4;
            const g = index < count ? level(index) : 255;
            data.set([g, g, g, 255], o);
        }
    }
    return { layout, png: encodePng({ width: layout.width, height: layout.height, channels: 4, data }) };
}

const words = (list: Array<[string, number, number]>) => JSON.stringify(list.map(([text, from, to]) => ({ text, start: from / FPS, end: to / FPS })));
const CASES: Array<[string, Record<string, unknown>]> = [
    ["typewriter", { textContent: "Hey!", animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }) }],
    ["karaoke (word starts on frame boundaries)", {
        textContent: "one two three four",
        textStyle: JSON.stringify({ karaoke: "highlight", highlightColor: "#ffe14d", captionKind: "caption" }),
        captionWordsJson: words([["one", 5, 10], ["two", 10, 25], ["three", 25, 40], ["four", 40, 60]]),
    }],
    ["glow loop", { textContent: "Glow", animationJson: JSON.stringify({ loop: { id: "glow", period: 1 } }) }],
    ["blur in", { textContent: "Blur", animationJson: JSON.stringify({ in: { id: "blur_in", duration: 0.5 } }) }],
];

describe.each(hosts.map((h) => [h.name, h] as const))("text state atlases on %s", (_name, host) => {
    for (const [name, patch] of CASES) {
        it(`${name}: the crop selects textStateAt(plan, n/30) at every frame`, async () => {
            const clip = makeClip("t", { trackType: "text", trackIndex: 1, startTime: START, endTime: START + SECONDS, ...patch });
            const plan = textStatePlan(clip);
            expect(plan.animated).toBe(true);
            const { layout, png } = atlasPng(plan.states.length);
            const raster: RasterResult = {
                id: "text-t", png, width: layout.width, height: layout.height, boxWidth: BOX.width, boxHeight: BOX.height, pad: BOX.pad, scale: 1,
                atlas: { cols: layout.cols, rows: layout.rows, cellWidth: layout.cellWidth, cellHeight: layout.cellHeight, count: plan.states.length },
            };
            const compiled = compileExport(input({ clips: [clip] }), { resolution: "720p" }, { media: new Map(), rasters: new Map([["text-t", raster]]), gl: false });
            // The compiled raster chain: time filters, then the atlas crop (nothing rescales a cell drawn at scale 1).
            const file = compiled.inputs.findIndex((i) => i.kind === "file");
            const chain = new RegExp(`\\[${file}:v\\](setpts=PTS-STARTPTS[^;\\[]*?crop=w=${CELL.width}:h=${CELL.height}:[^;\\[]*?exact=1)\\[`).exec(compiled.filterGraph)?.[1];
            expect(chain, compiled.filterGraph).toBeTruthy();
            const out = await runFilter(host, {
                frames: [],
                files: [{ name: compiled.inputs[file].source, data: png, options: compiled.inputs[file].options }],
                graph: `[0:v]${chain},format=rgb24[out]`,
            });
            const frames = splitFrames(out, CELL.width * CELL.height * 3);
            expect(frames).toHaveLength(SECONDS * FPS);
            const seen = new Set<number>();
            frames.forEach((frame, n) => {
                const center = ((CELL.height >> 1) * CELL.width + (CELL.width >> 1)) * 3;
                const observed = (frame[center] - 20) / 26;
                const expected = Math.round(evaluateScalar(plan.stateAt, n / FPS));
                expect(observed, `frame ${n}`).toBe(expected);
                expect(plan.states[observed], `frame ${n}`).toEqual(textStateAt(plan, n / FPS));
                // The whole frame is that one cell (no neighbour bleeds in).
                expect(frame.every((value, i) => i % 3 !== 0 || value === frame[center]), `frame ${n}`).toBe(true);
                seen.add(observed);
            });
            // Every state shows at least once over the two seconds.
            expect(seen.size).toBe(plan.states.length);
        }, 120_000);
    }
});

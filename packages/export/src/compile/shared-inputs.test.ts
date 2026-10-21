import { FilterGraph } from "../graph";
import { loopedStill, sharedStill } from "./shared-inputs";

describe("sharedStill", () => {
    it("reads a job file once and splits it to every user", () => {
        const graph = new FilterGraph();
        graph.input("media", "/m/a.webm", []);
        const first = sharedStill(graph, "look-0.png", ["format=rgb24"], "clut");
        const other = sharedStill(graph, "mask-1.png", ["format=gbrp"], "mask");
        const second = sharedStill(graph, "look-0.png", ["format=rgb24"], "clut");
        graph.chain(["0:v", first], ["haldclut"], "a");
        graph.chain(["a", second], ["haldclut"], "b");
        graph.chain(["b", other], ["blend=all_mode=multiply"], "c");
        expect(graph.inputs).toEqual([
            { kind: "media", source: "/m/a.webm", options: [] },
            { kind: "file", source: "look-0.png", options: [] },
            { kind: "file", source: "mask-1.png", options: [] },
        ]);
        expect(graph.toString().split(";\n")).toEqual([
            `[1:v]format=rgb24,split=2[${first}][${second}]`,
            `[2:v]format=gbrp[${other}]`,
            `[0:v][${first}]haldclut[a]`,
            `[a][${second}]haldclut[b]`,
            `[b][${other}]blend=all_mode=multiply[c]`,
        ]);
    });

    it("prints a lone user exactly as an unshared input", () => {
        const graph = new FilterGraph();
        const pad = sharedStill(graph, "look-0.png", ["format=rgb24"], "clut");
        expect(pad).toBe("clut0");
        expect(graph.toString()).toBe("[0:v]format=rgb24[clut0]");
    });

    it("keeps graphs apart", () => {
        const a = new FilterGraph();
        const b = new FilterGraph();
        sharedStill(a, "look-0.png", ["format=rgb24"], "clut");
        sharedStill(b, "look-0.png", ["format=rgb24"], "clut");
        expect(a.inputs).toHaveLength(1);
        expect(b.inputs).toHaveLength(1);
        expect(b.toString()).toBe("[0:v]format=rgb24[clut0]");
    });
});

describe("loopedStill", () => {
    it("repeats the shared frame on a 1/fps clock for the stream's frame count", () => {
        const graph = new FilterGraph();
        const a = loopedStill(graph, "grain-0.png", 30, 0.5, "grain");
        const b = loopedStill(graph, "grain-0.png", 30, 1 / 30, "grain");
        expect(graph.inputs).toHaveLength(1);
        const chains = graph.toString().split(";\n");
        expect(chains[0]).toMatch(/^\[0:v\]split=2\[still\d+\]\[still\d+\]$/);
        expect(chains[1]).toMatch(new RegExp(`settb=1/30,loop=loop=14:size=1:start=0,setpts=N/\\(30\\*TB\\)\\[${a}\\]$`));
        expect(chains[2]).toMatch(new RegExp(`settb=1/30,loop=loop=0:size=1:start=0,setpts=N/\\(30\\*TB\\)\\[${b}\\]$`));
    });

    it("counts frames the way an input -t does (timestamps below the length)", () => {
        const frames = (seconds: number) => {
            const graph = new FilterGraph();
            loopedStill(graph, "g.png", 30, seconds, "grain");
            return Number(graph.toString().match(/loop=loop=(\d+)/)![1]) + 1;
        };
        expect(frames(2)).toBe(60);
        expect(frames(1.98)).toBe(60);
        expect(frames(0.4)).toBe(12);
        expect(frames(0.0001)).toBe(1);
    });
});

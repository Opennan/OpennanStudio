import { FilterGraph, audioPad, videoPad } from "./graph";

describe("FilterGraph", () => {
    it("numbers inputs and renders chains", () => {
        const graph = new FilterGraph();
        const a = graph.input("media", "/a.mp4", ["-ss", "1.000"]);
        const b = graph.input("file", "text.png", ["-loop", "1"]);
        const bg = graph.chain([], ["color=c=black:s=64x64:r=30:d=1.000"], graph.label("bg"));
        graph.chain([bg, videoPad(b)], ["overlay=0:0"], "vout");
        graph.chain([audioPad(a)], ["anull"], "aout");
        expect([a, b]).toEqual([0, 1]);
        expect(graph.inputs[1]).toEqual({ kind: "file", source: "text.png", options: ["-loop", "1"] });
        expect(graph.toString()).toBe("color=c=black:s=64x64:r=30:d=1.000[bg0];\n[bg0][1:v]overlay=0:0[vout];\n[0:a]anull[aout]");
    });

    it("chains with several outputs (split filters)", () => {
        const graph = new FilterGraph();
        expect(graph.chainOutputs(["0:a"], ["anull", "asplit=2"], ["s0", "s1"])).toEqual(["s0", "s1"]);
        expect(graph.toString()).toBe("[0:a]anull,asplit=2[s0][s1]");
    });

    it("fills a reserved chain when printed, at the position it was reserved", () => {
        const graph = new FilterGraph();
        const users: string[] = [];
        graph.reserveChain(() => ({ inputs: ["0:v"], filters: ["format=rgb24", `split=${users.length}`], outputs: users }));
        users.push("c0");
        graph.chain(["c0"], ["null"], "x");
        users.push("c1");
        graph.chain(["c1"], ["null"], "y");
        expect(graph.toString()).toBe("[0:v]format=rgb24,split=2[c0][c1];\n[c0]null[x];\n[c1]null[y]");
        // Built on every print: a later user is included.
        users.push("c2");
        graph.chain(["c2"], ["null"], "z");
        expect(graph.toString()).toMatch(/^\[0:v\]format=rgb24,split=3\[c0\]\[c1\]\[c2\];/);
    });

    it("rejects empty chains", () => {
        expect(() => new FilterGraph().chain(["0:v"], [], "x")).toThrow("empty filter chain");
    });
});

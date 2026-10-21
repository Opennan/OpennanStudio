// An ffmpeg -filter_complex graph under construction: numbered inputs plus labelled chains.
import type { PlanInput } from "./types";

/** A chain whose shape is known only once the graph is complete (e.g. a split to every user of an input). */
export interface ReservedChain {
    inputs: string[];
    filters: string[];
    outputs: string[];
}

export class FilterGraph {
    readonly inputs: PlanInput[] = [];
    /** Printed chains, or builders of reserved chains (run on every print). */
    private readonly chains: Array<string | (() => ReservedChain)> = [];
    private counter = 0;

    /** Registers an ffmpeg input (its -i position) and returns its index. */
    input(kind: PlanInput["kind"], source: string, options: string[] = []): number {
        this.inputs.push({ kind, source, options });
        return this.inputs.length - 1;
    }

    /** A fresh pad label such as "v3". */
    label(prefix: string): string {
        const label = `${prefix}${this.counter}`;
        this.counter += 1;
        return label;
    }

    /** Appends "[in0][in1]f1,f2[out]" and returns `out`. A chain with no inputs is a source chain. */
    chain(inputs: string[], filters: string[], output: string): string {
        if (filters.length === 0) throw new Error(`empty filter chain for [${output}]`);
        this.chains.push(`${inputs.map((pad) => `[${pad}]`).join("")}${filters.join(",")}[${output}]`);
        return output;
    }

    /** Appends "[in]f1,split=n[o1][o2]…" (a chain ending in a filter with several outputs) and returns the outputs. */
    chainOutputs(inputs: string[], filters: string[], outputs: string[]): string[] {
        if (filters.length === 0 || outputs.length === 0) throw new Error("empty filter chain");
        this.chains.push(`${inputs.map((pad) => `[${pad}]`).join("")}${filters.join(",")}${outputs.map((pad) => `[${pad}]`).join("")}`);
        return outputs;
    }

    /**
     * Reserves a chain at this position and builds it when the graph is printed (compile/shared-inputs.ts: one
     * input split to users added later). Filter graph order is irrelevant to ffmpeg; the position only keeps
     * the printed graph stable.
     */
    reserveChain(build: () => ReservedChain): void {
        this.chains.push(build);
    }

    toString(): string {
        return this.chains.map((chain) => (typeof chain === "string" ? chain : printChain(chain()))).join(";\n");
    }
}

function printChain({ inputs, filters, outputs }: ReservedChain): string {
    if (filters.length === 0 || outputs.length === 0) throw new Error("empty filter chain");
    return `${inputs.map((pad) => `[${pad}]`).join("")}${filters.join(",")}${outputs.map((pad) => `[${pad}]`).join("")}`;
}

export function videoPad(input: number): string {
    return `${input}:v`;
}

export function audioPad(input: number): string {
    return `${input}:a`;
}

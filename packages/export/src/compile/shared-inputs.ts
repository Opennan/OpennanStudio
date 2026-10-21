// Job files the graph reads many times (Hald CLUTs, vignette masks, grain images) as one ffmpeg input each,
// split to their users (phase 10b). Every input opened is a demuxer and a decoder with its own buffers; a
// 40-scene project with transitions opened about three CLUTs per scene (one per head/body/tail read).
//
// Only single-frame streams are shared: split hands each user a reference to the one decoded frame and
// then EOF, so it buffers nothing however far apart its users run on the timeline. The users (haldclut,
// blend) keep the last frame of their second input (framesync repeatlast, the default), exactly as they do
// with a separate single-frame input; parity is tested on FFmpeg 5.1 (wasm) and 7.1 (desktop). A looped
// input (`-loop 1 -t`) would not be: split feeds every output at the pace of the fastest user, so a user
// later on the timeline would queue the whole difference. Looping is done per user after the split instead
// (loopedStill), with the loop filter holding the one frame.
import { sec } from "../format";
import { videoPad, type FilterGraph } from "../graph";

interface SharedStill {
    pads: string[];
}

const registries = new WeakMap<FilterGraph, Map<string, SharedStill>>();

/**
 * A pad of the single-frame job file `name` for one user, after `filters` (run once, before the split). The
 * first call registers the input; the chain prints at that position as `[i:v]filters,split=N[…]` (no split
 * for a lone user, so an unshared file prints as it always did).
 */
export function sharedStill(graph: FilterGraph, name: string, filters: string[], prefix: string): string {
    let registry = registries.get(graph);
    if (!registry) {
        registry = new Map();
        registries.set(graph, registry);
    }
    const key = `${name}|${filters.join(",")}`;
    let shared = registry.get(key);
    if (!shared) {
        const entry: SharedStill = { pads: [] };
        const input = graph.input("file", name, []);
        graph.reserveChain(() => ({
            inputs: [videoPad(input)],
            filters: entry.pads.length > 1 ? [...filters, `split=${entry.pads.length}`] : filters.length > 0 ? filters : ["null"],
            outputs: entry.pads,
        }));
        registry.set(key, entry);
        shared = entry;
    }
    const pad = graph.label(prefix);
    shared.pads.push(pad);
    return pad;
}

/**
 * The image `name` as a stream of frames 0, 1/fps, 2/fps, … for `seconds` (the frames an input
 * `-loop 1 -framerate fps -t seconds` gives: timestamps below the length), from the shared single frame.
 */
export function loopedStill(graph: FilterGraph, name: string, fps: number, seconds: number, prefix: string): string {
    const frames = Math.max(1, Math.ceil(Number(sec(seconds)) * fps - 1e-6));
    const still = sharedStill(graph, name, [], "still");
    return graph.chain([still], [`settb=1/${fps}`, `loop=loop=${frames - 1}:size=1:start=0`, `setpts=N/(${fps}*TB)`], graph.label(prefix));
}

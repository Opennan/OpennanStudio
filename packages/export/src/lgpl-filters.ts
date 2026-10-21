// The bundled desktop ffmpeg is an LGPL build (spec §3): compiled graphs must only use filters it has.
// GPL_ONLY_FILTERS is every `<name>_filter_deps` entry containing "gpl" in FFmpeg 7.1.5's configure.
import { eqPlanes } from "@opennan/timeline-core/looks/legacy";
import type { ColorAdjustments } from "./clip-params";

export const GPL_ONLY_FILTERS: readonly string[] = [
    "blackframe", "boxblur", "boxblur_opencl", "colormatrix", "cover_rect", "cropdetect", "delogo", "eq", "find_rect", "fspp",
    "histeq", "hqdn3d", "interlace", "kerndeint", "mcdeint", "mpdecimate", "mptestsrc", "nnedi", "owdenoise", "perspective",
    "phase", "pp7", "pp", "pullup", "repeatfields", "sab", "signature", "smartblur", "spp", "stereo3d",
    "super2xsai", "tinterlace", "uspp", "vaguedenoiser",
];

/** GPL-only filter names used in a filter graph (names at the start of each filter in a chain). */
export function gplFiltersIn(graph: string): string[] {
    const found = new Set<string>();
    // A filter name follows "]", ",", ";" or the start, and precedes "=", ",", ";", "[" or the end.
    for (const match of graph.matchAll(/(?:^|[\],;])\s*([a-z0-9_]+)(?=\s*(?:=|,|;|\[|$))/g)) {
        if (GPL_ONLY_FILTERS.includes(match[1])) found.add(match[1]);
    }
    return [...found];
}

// pel = ((val * C) >> 12) + B clipped to 0-255; lutyuv's own clip would clamp to the limited range.
const planeExpression = ([c, b]: readonly [number, number]) => `'clip(floor(val*${c}/4096)${b < 0 ? b : `+${b}`},0,255)'`;

/**
 * eq with brightness, contrast and saturation (gamma 1) as an LGPL lutyuv with eq's exact 8-bit lookup; null when
 * nothing changes. Planes eq copies are written as `val` (lutyuv's default, clipval, would clamp them).
 */
export function eqLookup(color: ColorAdjustments): string | null {
    const { luma, chroma } = eqPlanes(color);
    if (!luma && !chroma) return null;
    const lumaPart = luma ? planeExpression(luma) : "val";
    const chromaPart = chroma ? planeExpression(chroma) : "val";
    return `lutyuv=y=${lumaPart}:u=${chromaPart}:v=${chromaPart}`;
}

/**
 * The 8-bit planar YUV formats eq accepts (gray8 aside). eq made ffmpeg convert anything else (10-bit
 * video, RGB, full-range yuvj) to one of these; lutyuv accepts more, and the eq lookup is 8-bit only.
 */
export const EQ_PIXEL_FORMATS = "format=pix_fmts=yuv410p|yuv411p|yuv420p|yuva420p|yuv422p|yuva422p|yuv444p|yuva444p";

/** Inserts EQ_PIXEL_FORMATS before the first eq lookup in a filter list, so every lookup sees 8-bit input. */
export function pinEqFormats(filters: readonly string[]): string[] {
    const first = filters.findIndex((filter) => filter.startsWith("lutyuv="));
    return first < 0 ? [...filters] : [...filters.slice(0, first), EQ_PIXEL_FORMATS, ...filters.slice(first)];
}

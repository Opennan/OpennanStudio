// Animated GIF timing for the GPU export path (phase 10d): the frame delays and loop count read from the file's own
// blocks, timed as ffmpeg's GIF demuxer times them for the compatible export's `-ignore_loop 0` input, so both
// engines show the same GIF frame at every output frame. Pixels come from WebCodecs' ImageDecoder (gpu/media.ts).
// Pure: no DOM.

export interface GifInfo {
    width: number;
    height: number;
    /** Per frame, the delay of its Graphic Control Extension in centiseconds (0 when it has none). */
    delays: number[];
    /** NETSCAPE2.0 loop count: 0 = forever, n = n plays; null when the file has no loop extension (one play). */
    loopCount: number | null;
}

/** Parses a GIF's block structure (no pixels). Throws on a file that is not a GIF. */
export function parseGif(bytes: Uint8Array): GifInfo {
    const ascii = String.fromCharCode(...bytes.subarray(0, 6));
    if (ascii !== "GIF87a" && ascii !== "GIF89a") throw new Error("not a GIF file"); // i18n-ignore
    const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
    const width = u16(6);
    const height = u16(8);
    let o = 13;
    if (bytes[10] & 0x80) o += 3 * (1 << ((bytes[10] & 7) + 1));
    const skipSubBlocks = () => {
        while (o < bytes.length && bytes[o] !== 0) o += bytes[o] + 1;
        o += 1;
    };
    const delays: number[] = [];
    let loopCount: number | null = null;
    let pendingDelay = 0;
    while (o < bytes.length) {
        const block = bytes[o];
        if (block === 0x3b) break;
        if (block === 0x21) {
            const label = bytes[o + 1];
            o += 2;
            if (label === 0xf9 && bytes[o] >= 4) pendingDelay = u16(o + 2);
            else if (label === 0xff && bytes[o] === 11 && String.fromCharCode(...bytes.subarray(o + 1, o + 12)) === "NETSCAPE2.0") {
                const sub = o + 12;
                if (bytes[sub] >= 3 && bytes[sub + 1] === 1) loopCount = u16(sub + 2);
            }
            skipSubBlocks();
        } else if (block === 0x2c) {
            const packed = bytes[o + 9];
            o += 10;
            if (packed & 0x80) o += 3 * (1 << ((packed & 7) + 1));
            o += 1; // LZW minimum code size
            skipSubBlocks();
            delays.push(pendingDelay);
            pendingDelay = 0;
        } else {
            break;
        }
    }
    return { width, height, delays, loopCount };
}

/**
 * ffmpeg's GIF demuxer delay rule as the export pins it (`-min_delay 1`, compile/index.ts mediaOverlay): a delay
 * below min_delay (only 0) plays default_delay. FFmpeg 5.1 and 7.1 agree with it (measured).
 */
export const GIF_MIN_DELAY_CS = 1;
export const GIF_DEFAULT_DELAY_CS = 10;

/** Seconds each frame shows, as ffmpeg's demuxer times them. */
export function gifFrameDurations(info: GifInfo): number[] {
    return info.delays.map((cs) => (cs < GIF_MIN_DELAY_CS ? GIF_DEFAULT_DELAY_CS : Math.min(cs, 65535)) / 100);
}

/** How many times the GIF plays with `-ignore_loop 0`: the loop count (0 = forever), once without the extension. */
export function gifPlays(info: GifInfo): number {
    if (info.loopCount === null) return 1;
    return info.loopCount === 0 ? Infinity : info.loopCount;
}

export interface GifFrame {
    /** Presentation time from the first frame (seconds). */
    time: number;
    /** The GIF's own frame index (loops repeat 0 … n − 1). */
    image: number;
}

/** The GIF's frames on ffmpeg's timeline before `limit` seconds (`-t`), loops unrolled. */
export function gifTimeline(info: GifInfo, limit: number): GifFrame[] {
    const durations = gifFrameDurations(info);
    const out: GifFrame[] = [];
    if (durations.length === 0) return out;
    const plays = gifPlays(info);
    let time = 0;
    // Centiseconds add up exactly in integers; seconds are derived once per frame.
    let cs = 0;
    for (let play = 0; play < plays; play += 1) {
        for (let image = 0; image < durations.length; image += 1) {
            time = cs / 100;
            if (time >= limit - 1e-9) return out;
            out.push({ time, image });
            cs += Math.round(durations[image] * 100);
        }
    }
    return out;
}

/** Seconds until the GIF's last play ends (Infinity when it loops forever). */
export function gifEnd(info: GifInfo): number {
    const plays = gifPlays(info);
    const cycle = gifFrameDurations(info).reduce((a, b) => a + b, 0);
    return plays === Infinity ? Infinity : plays * cycle;
}

/**
 * The GIF frame (its own index) a read shows at `t` seconds from its first frame: the last frame at or before `t`,
 * null once the last play has ended (the ffmpeg input has ended). `reverse` (ffmpeg's `reverse` on the first `span`
 * seconds): the forward pick j of those n frames shows frame n − 1 − j.
 */
export function gifPick(info: GifInfo, t: number, reverse?: { span: number }): number | null {
    const durations = gifFrameDurations(info);
    if (durations.length === 0) return null;
    if (reverse) {
        const frames = gifTimeline(info, reverse.span);
        if (frames.length === 0) return null;
        let j = 0;
        while (j + 1 < frames.length && frames[j + 1].time <= t + 1e-9) j += 1;
        return frames[frames.length - 1 - j].image;
    }
    if (t >= gifEnd(info) - 1e-9) return null;
    const cs = durations.map((d) => Math.round(d * 100));
    const cycle = cs.reduce((a, b) => a + b, 0);
    let within = Math.max(0, t) * 100 - Math.floor((Math.max(0, t) * 100 + 1e-7) / cycle) * cycle;
    for (let image = 0; image < cs.length; image += 1) {
        if (within < cs[image] - 1e-7) return image;
        within -= cs[image];
    }
    return cs.length - 1;
}

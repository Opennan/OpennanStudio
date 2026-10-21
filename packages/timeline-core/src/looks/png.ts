// Dependency-free PNG writer for the images the looks engine generates (Hald CLUTs, vignette masks,
// grain atlases). Uses stored (uncompressed) deflate blocks: no compressor needed, valid everywhere,
// decoded byte-exactly by ffmpeg and browsers.

export interface PngImage {
    width: number;
    height: number;
    /** 1 = gray, 3 = RGB, 4 = RGBA; 8 bits per channel, rows top-first. */
    channels: 1 | 3 | 4;
    data: Uint8Array;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
    let c = (seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

const COLOR_TYPE: Record<PngImage["channels"], number> = { 1: 0, 3: 2, 4: 6 };

/** zlib stream of stored blocks. */
function storedZlib(raw: Uint8Array): Uint8Array {
    const blocks = Math.max(1, Math.ceil(raw.length / 65535));
    const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
    out[0] = 0x78;
    out[1] = 0x01;
    let o = 2;
    for (let i = 0; i < blocks; i += 1) {
        const start = i * 65535;
        const len = Math.min(65535, raw.length - start);
        out[o] = i === blocks - 1 ? 1 : 0;
        out[o + 1] = len & 0xff;
        out[o + 2] = len >>> 8;
        out[o + 3] = ~len & 0xff;
        out[o + 4] = (~len >>> 8) & 0xff;
        out.set(raw.subarray(start, start + len), o + 5);
        o += 5 + len;
    }
    const adler = adler32(raw);
    out[o] = adler >>> 24;
    out[o + 1] = (adler >>> 16) & 0xff;
    out[o + 2] = (adler >>> 8) & 0xff;
    out[o + 3] = adler & 0xff;
    return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

export function encodePng(image: PngImage): Uint8Array {
    const { width, height, channels, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("PNG size must be positive integers");
    if (data.length !== width * height * channels) throw new Error(`PNG data must be ${width * height * channels} bytes`);
    const stride = width * channels;
    const raw = new Uint8Array(height * (stride + 1));
    for (let y = 0; y < height; y += 1) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = COLOR_TYPE[channels];
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", storedZlib(raw)),
        chunk("IEND", new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

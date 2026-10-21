import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodePng } from "./png";

function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array; crc: number }> {
    const out: Array<{ type: string; data: Uint8Array; crc: number }> = [];
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8;
    while (offset < png.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
        const data = png.subarray(offset + 8, offset + 8 + length);
        out.push({ type, data, crc: view.getUint32(offset + 8 + length) });
        offset += 12 + length;
    }
    return out;
}

describe("encodePng", () => {
    it("computes the standard CRC-32", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
        expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    });

    it("writes a valid RGB PNG whose rows inflate back", () => {
        const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
        const png = encodePng({ width: 2, height: 2, channels: 3, data: rgb });
        expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const parts = chunks(png);
        expect(parts.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
        const ihdr = new DataView(parts[0].data.buffer, parts[0].data.byteOffset);
        expect([ihdr.getUint32(0), ihdr.getUint32(4), parts[0].data[8], parts[0].data[9]]).toEqual([2, 2, 8, 2]);
        for (const part of parts) {
            const typed = new Uint8Array(4 + part.data.length);
            typed.set(new TextEncoder().encode(part.type));
            typed.set(part.data, 4);
            expect(crc32(typed)).toBe(part.crc);
        }
        const raw = inflateSync(parts[1].data);
        expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 10, 20, 30]);
    });

    it("splits large images into stored blocks of at most 65535 bytes", () => {
        const gray = new Uint8Array(400 * 300).map((_, i) => i % 251);
        const png = encodePng({ width: 400, height: 300, channels: 1, data: gray });
        const idat = chunks(png).find((c) => c.type === "IDAT")!;
        const raw = inflateSync(idat.data);
        expect(raw.length).toBe(300 * 401);
        expect(raw[401 + 1]).toBe(gray[400]);
        expect(chunks(png)[0].data[9]).toBe(0);
    });

    it("rejects a buffer of the wrong size", () => {
        expect(() => encodePng({ width: 2, height: 2, channels: 3, data: new Uint8Array(5) })).toThrow();
    });
});

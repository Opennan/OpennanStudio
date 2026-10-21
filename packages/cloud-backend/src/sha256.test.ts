import { webcrypto } from "node:crypto";
import { createSha256, hashBlob, toHex } from "./sha256";

async function reference(bytes: Uint8Array): Promise<string> {
    return toHex(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)));
}

function random(n: number, seed = 7): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

describe("sha256", () => {
    it("matches the known vectors", () => {
        expect(createSha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(createSha256().update(new TextEncoder().encode("abc")).digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("matches WebCrypto at every block boundary, fed in one piece or byte by byte", async () => {
        for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
            const bytes = random(n, n);
            const whole = createSha256().update(bytes).digestHex();
            const split = createSha256();
            for (let i = 0; i < n; i += 7) split.update(bytes.subarray(i, Math.min(n, i + 7)));
            expect(whole).toBe(await reference(bytes));
            expect(split.digestHex()).toBe(whole);
        }
    });

    it("hashes a Blob streaming, the same as the bytes, and stops on abort", async () => {
        const bytes = random(3 * 1024 * 1024 + 17);
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        expect(await hashBlob(blob)).toBe(await reference(bytes));
        const controller = new AbortController();
        controller.abort();
        await expect(hashBlob(blob, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    });

    it("cannot be updated after its digest", () => {
        const hash = createSha256();
        hash.digestHex();
        expect(() => hash.update(new Uint8Array(1))).toThrow();
    });
});

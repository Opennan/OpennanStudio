import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { createMediaProtocolHandler, parseRange } from "./media-protocol";

describe("parseRange", () => {
    it.each([
        [null, null], ["bytes=0-99", { start: 0, end: 99 }], ["bytes=900-", { start: 900, end: 999 }], ["bytes=-10", { start: 990, end: 999 }],
        ["bytes=990-5000", { start: 990, end: 999 }], ["bytes=1000-", "unsatisfiable"], ["bytes=5-1", "unsatisfiable"], ["bytes=-0", "unsatisfiable"],
        ["bytes=0-1,5-6", null], ["items=0-1", null], ["bytes=-", null], ["bytes=a-b", null],
    ])("%s", (header, expected) => {
        expect(parseRange(header as string | null, 1000)).toEqual(expected);
    });
});

describe("opennan-media protocol", () => {
    let dir: string;
    let db: DesktopDatabase;
    let store: MediaStore;
    let id: string;
    let handler: (request: Request) => Promise<Response>;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-mp-"));
        db = openDatabase(":memory:");
        store = createMediaStore({ db, root: path.join(dir, "media") });
        const source = path.join(dir, "a.mp4");
        fs.writeFileSync(source, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
        id = (await store.importPath({ projectId: randomUUID(), path: source, kind: "video" })).url.slice("opennan-local://media/".length);
        handler = createMediaProtocolHandler(store);
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const get = (url: string, range?: string) => new Request(url, range ? { headers: { Range: range } } : undefined);

    it("serves the whole file with CORS for the app only", async () => {
        const res = await handler(get(`opennan-media://blob/${id}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe("1000");
        expect(res.headers.get("content-type")).toBe("video/mp4");
        expect(res.headers.get("access-control-allow-origin")).toBe("opennan-app://app");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect((await res.arrayBuffer()).byteLength).toBe(1000);
    });

    it.each([
        ["bytes=0-99", 206, "bytes 0-99/1000", 100], ["bytes=900-", 206, "bytes 900-999/1000", 100], ["bytes=-10", 206, "bytes 990-999/1000", 10],
        ["bytes=1000-", 416, "bytes */1000", 0],
    ])("Range %s -> %i", async (range, status, contentRange, length) => {
        const res = await handler(get(`opennan-media://blob/${id}`, range));
        expect(res.status).toBe(status);
        expect(res.headers.get("content-range")).toBe(contentRange);
        expect((await res.arrayBuffer()).byteLength).toBe(length);
    });

    it("returns the right bytes for a range", async () => {
        const res = await handler(get(`opennan-media://blob/${id}`, "bytes=256-259"));
        expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    });

    it.each([
        "opennan-media://blob/not-a-uuid", "opennan-media://other/x", "opennan-media://refused/https%3A%2F%2Fevil",
    ])("refuses %s", async (url) => {
        expect((await handler(get(url))).status).toBe(403);
    });

    it("refuses unknown ids, extra path segments, and queries", async () => {
        expect((await handler(get(`opennan-media://blob/${randomUUID()}`))).status).toBe(403);
        expect((await handler(get(`opennan-media://blob/${id}/../x`))).status).toBe(403);
        expect((await handler(get(`opennan-media://blob/${id}/x`))).status).toBe(403);
        expect((await handler(get(`opennan-media://blob/${id}?x=1`))).status).toBe(403);
    });

    it("HEAD has headers and no body; other methods are refused", async () => {
        const head = await handler(new Request(`opennan-media://blob/${id}`, { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("1000");
        expect(await head.text()).toBe("");
        expect((await handler(new Request(`opennan-media://blob/${id}`, { method: "POST", body: "x" }))).status).toBe(405);
    });

    it("answers a file deleted behind the store's back with 403 or 404", async () => {
        fs.rmSync(store.pathOf(id)!);
        expect([403, 404]).toContain((await handler(get(`opennan-media://blob/${id}`))).status);
    });
});

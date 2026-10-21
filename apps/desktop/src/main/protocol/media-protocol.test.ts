import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { createMediaProtocolHandler, parseRange, type StreamSource } from "./media-protocol";

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

describe("opennan-media protocol: a cloud file still downloading", () => {
    const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);
    let dir: string;
    let db: DesktopDatabase;
    let store: MediaStore;
    let opened: Array<[number, number]>;
    let failing: boolean;
    const STREAMED = "66666666-2222-4333-8444-555555555555";

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-mp-stream-"));
        db = openDatabase(":memory:");
        store = createMediaStore({ db, root: path.join(dir, "media") });
        opened = [];
        failing = false;
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const source: StreamSource = {
        size: BYTES.byteLength,
        mimeType: "video/webm",
        async open(start, end) {
            opened.push([start, end]);
            if (failing) throw new Error("storage refused");
            return new Response(BYTES.slice(start, end + 1)).body!;
        },
    };
    const handler = () => createMediaProtocolHandler(store, { streaming: async (id) => (id === STREAMED ? source : null) });
    const get = (range?: string, method = "GET") => new Request(`opennan-media://blob/${STREAMED}`, { method, ...(range ? { headers: { Range: range } } : {}) });

    it("serves it like a stored file: whole, ranges, HEAD, 416, with the same headers", async () => {
        const whole = await handler()(get());
        expect(whole.status).toBe(200);
        expect(Object.fromEntries(whole.headers)).toMatchObject({
            "content-type": "video/webm", "accept-ranges": "bytes", "access-control-allow-origin": "opennan-app://app", "x-content-type-options": "nosniff",
            "cache-control": "no-store", "content-length": "100",
        });
        expect(new Uint8Array(await whole.arrayBuffer())).toEqual(BYTES);
        const range = await handler()(get("bytes=10-19"));
        expect(range.status).toBe(206);
        expect(range.headers.get("content-range")).toBe("bytes 10-19/100");
        expect(range.headers.get("content-length")).toBe("10");
        expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
        expect(opened).toEqual([[0, 99], [10, 19]]);
        const head = await handler()(get(undefined, "HEAD"));
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("100");
        expect(await head.text()).toBe("");
        const beyond = await handler()(get("bytes=100-"));
        expect(beyond.status).toBe(416);
        expect(beyond.headers.get("content-range")).toBe("bytes */100");
        expect(opened).toHaveLength(2);
    });

    it("answers 502 when the storage behind it fails, and 403 for ids nothing streams", async () => {
        failing = true;
        expect((await handler()(get("bytes=0-9"))).status).toBe(502);
        expect((await handler()(new Request(`opennan-media://blob/${randomUUID()}`))).status).toBe(403);
        // Without a streaming source the handler is the stored-files one.
        expect((await createMediaProtocolHandler(store)(get())).status).toBe(403);
    });

    it("prefers the stored file once it is in the media store", async () => {
        const temp = path.join(dir, "done.part");
        fs.writeFileSync(temp, Buffer.from(BYTES));
        await store.adoptFile({ id: STREAMED, projectId: null, path: temp, name: "a.webm", mimeType: "video/webm" });
        const res = await handler()(get("bytes=0-1"));
        expect(res.status).toBe(206);
        expect(opened).toEqual([]);
    });
});

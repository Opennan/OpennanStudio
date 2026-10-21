import { CloudApiError, type CloudApi } from "./api";
import { isAllowedUploadTarget, uploadBlob } from "./upload";

interface Recorded { method: string; url: string; body?: unknown; headers?: Record<string, string> }

/** A fake API + gateway: single-use URLs (a second PUT is 410), parts with ETags, dedup by sha256. */
function fakeCloud(options: { dedup?: boolean; singleMax?: number; partSize?: number; failPuts?: number[]; usedOnce?: boolean; refuse?: CloudApiError; shuffleParts?: (parts: Array<{ number: number; size: number; url: string }>) => Array<{ number: number; size: number; url: string }> } = {}) {
    const calls: Recorded[] = [];
    const used = new Set<string>();
    let uploads = 0;
    let puts = 0;
    const singleMax = options.singleMax ?? 10;
    const partSize = options.partSize ?? 4;
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: string, path: string, request: { body?: unknown } = {}) {
            calls.push({ method, url: path, body: request.body });
            const body = request.body as Record<string, unknown>;
            if (path === "/v1/uploads") {
                if (options.refuse) throw options.refuse;
                if (options.dedup) return { status: 200, etag: null, body: { object: "upload", deduplicated: true, asset_id: "asset_d", media_url: "https://cdn.opennan.com/uploads/media/o/abc.mp4", content_type: body.content_type, size_bytes: body.size_bytes } as T };
                uploads += 1;
                const size = body.size_bytes as number;
                if (size > singleMax) {
                    const parts = [];
                    for (let n = 1, offset = 0; offset < size; n++, offset += partSize) parts.push({ number: n, size: Math.min(partSize, size - offset), url: `https://upload.opennan.com/u/t${uploads}-p${n}` });
                    return { status: 201, etag: null, body: { upload_id: `up_${uploads}`, upload_url: null, multipart: { part_size: partSize, parts: options.shuffleParts ? options.shuffleParts(parts) : parts }, media_url: `https://cdn.opennan.com/m${uploads}.mp4`, headers: {} } as T };
                }
                return { status: 201, etag: null, body: { upload_id: `up_${uploads}`, upload_url: `https://upload.opennan.com/u/t${uploads}`, media_url: `https://cdn.opennan.com/m${uploads}.mp4`, headers: { "Content-Type": body.content_type } } as T };
            }
            const complete = /^\/v1\/uploads\/(up_\d+)\/complete$/.exec(path);
            if (complete) return { status: 200, etag: null, body: { asset_id: `asset_${complete[1]}`, media_url: `https://cdn.opennan.com/${complete[1]}.mp4`, content_type: "video/mp4", size_bytes: 1 } as T };
            throw new Error(`unexpected ${path}`);
        },
    };
    const fetch = (async (url: string, init: RequestInit) => {
        puts += 1;
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        calls.push({ method: init.method!, url, headers, body: init.body });
        if (options.failPuts?.includes(puts)) return new Response(JSON.stringify({ error: { code: "upload_failed" } }), { status: 502 });
        if (used.has(url) || (options.usedOnce && puts === 1)) return new Response(JSON.stringify({ error: { type: "conflict", code: "upload_url_used", message: "used" } }), { status: 410 });
        used.add(url);
        return new Response(JSON.stringify({ etag: `etag-${url.split("/").pop()}` }), { status: 200, headers: { etag: `"etag-${url.split("/").pop()}"` } });
    }) as unknown as typeof globalThis.fetch;
    return { api, fetch, calls };
}

const blob = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: "video/mp4" });
const start = (n: number) => ({ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: n, sha256: "a".repeat(64), projectId: "p1" });

describe("uploadBlob", () => {
    it("asks with sha256, scope account, the project and multipart, and takes a dedup answer without sending bytes", async () => {
        const cloud = fakeCloud({ dedup: true });
        const result = await uploadBlob(cloud.api, cloud.fetch, blob(5), start(5));
        expect(result).toMatchObject({ assetId: "asset_d", deduplicated: true });
        expect(cloud.calls).toHaveLength(1);
        expect(cloud.calls[0]!.body).toEqual({ filename: "clip.mp4", content_type: "video/mp4", size_bytes: 5, sha256: "a".repeat(64), scope: "account", project_id: "p1", multipart: true });
    });

    it("PUTs once through the gateway without credentials, then completes", async () => {
        const cloud = fakeCloud();
        const result = await uploadBlob(cloud.api, cloud.fetch, blob(5), start(5));
        expect(result).toMatchObject({ assetId: "asset_up_1", mediaUrl: "https://cdn.opennan.com/up_1.mp4", deduplicated: false });
        const put = cloud.calls.find((c) => c.method === "PUT")!;
        expect(put.url).toBe("https://upload.opennan.com/u/t1");
        expect(put.headers!["content-type"]).toBe("video/mp4");
        expect(put.headers!.authorization).toBeUndefined();
    });

    it("starts a new upload when the single-use link was already used (410)", async () => {
        const cloud = fakeCloud({ usedOnce: true });
        const result = await uploadBlob(cloud.api, cloud.fetch, blob(5), start(5));
        expect(result.assetId).toBe("asset_up_2");
        expect(cloud.calls.filter((c) => c.url === "/v1/uploads")).toHaveLength(2);
    });

    it("retries the same link after a storage failure (502)", async () => {
        const cloud = fakeCloud({ failPuts: [1] });
        const result = await uploadBlob(cloud.api, cloud.fetch, blob(5), start(5), { retryDelayMs: 0 });
        expect(result.assetId).toBe("asset_up_1");
        expect(cloud.calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(["https://upload.opennan.com/u/t1", "https://upload.opennan.com/u/t1"]);
    });

    it("sends big files in parts with their ETags and reports progress", async () => {
        const cloud = fakeCloud({ singleMax: 10, partSize: 4 });
        const progress: number[] = [];
        await uploadBlob(cloud.api, cloud.fetch, blob(11), start(11), { onProgress: (sent) => progress.push(sent) });
        const puts = cloud.calls.filter((c) => c.method === "PUT");
        expect(puts.map((p) => (p.body as Blob).size)).toEqual([4, 4, 3]);
        const complete = cloud.calls.find((c) => c.url.endsWith("/complete"))!;
        expect(complete.body).toEqual({ parts: [{ number: 1, etag: "etag-t1-p1" }, { number: 2, etag: "etag-t1-p2" }, { number: 3, etag: "etag-t1-p3" }] });
        expect(progress.at(-1)).toBe(11);
    });

    it("sends parts by their numbers whatever order the server lists them in, and refuses numbers that don't make up 1..n (review)", async () => {
        const cloud = fakeCloud({ singleMax: 10, partSize: 4, shuffleParts: (parts) => [...parts].reverse() });
        const bytes = new Uint8Array(11).map((_, i) => i);
        await uploadBlob(cloud.api, cloud.fetch, new Blob([bytes], { type: "video/mp4" }), start(11));
        const puts = cloud.calls.filter((c) => c.method === "PUT");
        const sent = await Promise.all(puts.map(async (p) => [p.url.split("-").pop(), [...new Uint8Array(await (p.body as Blob).arrayBuffer())]] as const));
        expect(Object.fromEntries(sent)).toEqual({ p1: [0, 1, 2, 3], p2: [4, 5, 6, 7], p3: [8, 9, 10] });
        for (const shuffle of [(parts: Array<{ number: number; size: number; url: string }>) => [parts[0]!, parts[0]!, parts[2]!], (parts: Array<{ number: number; size: number; url: string }>) => parts.map((p) => ({ ...p, number: p.number + 1 }))]) {
            const bad = fakeCloud({ singleMax: 10, partSize: 4, shuffleParts: shuffle });
            await expect(uploadBlob(bad.api, bad.fetch, blob(11), start(11))).rejects.toMatchObject({ code: "invalid_response" });
            expect(bad.calls.filter((c) => c.method === "PUT")).toEqual([]);
        }
    });

    it("passes the server's refusal through (quota)", async () => {
        const cloud = fakeCloud({ refuse: new CloudApiError(403, "storage_quota_exceeded", "full") });
        await expect(uploadBlob(cloud.api, cloud.fetch, blob(5), start(5))).rejects.toMatchObject({ code: "storage_quota_exceeded" });
    });

    it("never PUTs to a host it does not trust", () => {
        expect(isAllowedUploadTarget("https://upload.opennan.com/u/x", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadTarget("https://bucket.r2.cloudflarestorage.com/k?sig", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadTarget("https://api.opennan.com/__uploads/1", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadTarget("http://upload.opennan.com/u/x", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadTarget("https://evil.example/u/x", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadTarget("https://169.254.169.254/x", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadTarget("http://127.0.0.1:4320/u/x", "http://127.0.0.1:4320")).toBe(true);
        expect(isAllowedUploadTarget("http://127.0.0.1:9999/u/x", "http://127.0.0.1:4320")).toBe(false);
    });
});

// Export and share's upload step on the web (phase 9c): the export's file (in memory or on the origin's private disk)
// hashed and uploaded with the project's id through the cloud media upload, its progress, and the disk file let go.
import type { CloudApi, CloudMethod, CloudRequest } from "@opennan/cloud-backend";
import type { ExportResult } from "@opennan/export";
import { createExportUpload } from "./share-upload";

function api(calls: Array<{ method: CloudMethod; path: string; body?: unknown }>): CloudApi {
    return {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, request?: CloudRequest) {
            calls.push({ method, path, body: request?.body });
            // The account already has this file: nothing is sent.
            return { status: 200, body: { deduplicated: true, asset_id: "ast_1", media_url: "https://cdn.opennan.com/uploads/media/o/export.mp4" } as T, etag: null };
        },
    };
}

const resultOf = (output: Record<string, unknown>, mimeType = "video/mp4") => ({ output, mimeType, container: mimeType === "video/mp4" ? "mp4" : "webm" }) as unknown as ExportResult;

describe("createExportUpload", () => {
    it("uploads the export with the project's id and its content type, reports progress, and removes the disk file", async () => {
        const calls: Array<{ method: CloudMethod; path: string; body?: unknown }> = [];
        const removed: string[] = [];
        const upload = createExportUpload({ api: () => api(calls), hash: async () => "f".repeat(64), removeFile: async (name) => void removed.push(name), name: () => "Trip" });
        const ratios: number[] = [];
        const blob = new Blob([new Uint8Array(10)], { type: "video/mp4" });
        const answer = await upload(resultOf({ kind: "blob", blob, opfsName: "export-1.mp4" }), "p1", { signal: new AbortController().signal, onProgress: (r) => ratios.push(r) });
        expect(answer).toEqual({ mediaUrl: "https://cdn.opennan.com/uploads/media/o/export.mp4" });
        expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/uploads", body: { filename: "Trip.mp4", content_type: "video/mp4", size_bytes: 10, sha256: "f".repeat(64), project_id: "p1", scope: "account" } });
        expect(ratios.at(-1)).toBe(1);
        expect(removed).toEqual(["export-1.mp4"]);
    });

    it("takes a WebM export as WebM, and refuses a format OpenNan can't hold before sending anything", async () => {
        const calls: Array<{ method: CloudMethod; path: string; body?: unknown }> = [];
        const upload = createExportUpload({ api: () => api(calls), hash: async () => "a".repeat(64), name: () => "" });
        await upload(resultOf({ kind: "bytes", data: new Uint8Array(3) }, "video/webm"), "p1", { signal: new AbortController().signal, onProgress: () => undefined });
        expect(calls[0]!.body).toMatchObject({ filename: "export.webm", content_type: "video/webm" });
        await expect(upload(resultOf({ kind: "bytes", data: new Uint8Array(3) }, "image/gif-animated"), "p1", { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(/can't hold/);
        expect(calls).toHaveLength(1);
    });

    it("refuses without an account", async () => {
        const upload = createExportUpload({ api: () => null, hash: async () => "a".repeat(64) });
        await expect(upload(resultOf({ kind: "bytes", data: new Uint8Array(3) }), "p1", { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: "signed_out" });
    });
});

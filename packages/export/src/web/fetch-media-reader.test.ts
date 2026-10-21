import { createFetchMediaReader } from "./fetch-media-reader";

describe("createFetchMediaReader", () => {
    const calls: Array<{ url: string; headers?: Record<string, string>; credentials?: RequestCredentials }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: init?.headers as Record<string, string> | undefined, credentials: init?.credentials });
        return new Response(new Uint8Array([7]));
    }) as unknown as typeof fetch;
    const media = { resolveMediaUrl: (url: string) => url, getAuthHeaders: async () => ({ Authorization: "Bearer secret" }), origin: "https://studio.example" };
    beforeEach(() => {
        calls.length = 0;
    });

    it("authenticates same-origin and allowlisted media", async () => {
        const read = createFetchMediaReader(media, { fetch: fetchStub, authOrigins: ["https://api.opennan.example"] });
        expect([...(await read("/media/a.webm"))]).toEqual([7]);
        await read("https://api.opennan.example/m/b.webm");
        expect(calls.map((c) => c.headers?.Authorization)).toEqual(["Bearer secret", "Bearer secret"]);
    });

    it("never sends the token or cookies to another origin", async () => {
        const read = createFetchMediaReader(media, { fetch: fetchStub });
        await read("https://evil.example/clip.mp4");
        await read("blob:https://studio.example/1234");
        expect(calls.map((c) => [c.headers, c.credentials])).toEqual([[undefined, "omit"], [undefined, "omit"]]);
    });

    it("refuses URLs the media environment cannot fetch", async () => {
        const read = createFetchMediaReader({ ...media, canFetchMediaBytes: (url: string) => !url.startsWith("opennan-local:") }, { fetch: fetchStub });
        await expect(read("opennan-local://x")).rejects.toThrow(/cannot be fetched/);
        expect(calls).toEqual([]);
    });
});

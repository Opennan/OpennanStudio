import { checkDownloadUrl, downloadMedia, isPrivateHost } from "./download";

function fetchScript(answers: Record<string, () => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        const answer = answers[String(input)];
        if (!answer) throw new Error(`unexpected ${String(input)}`);
        return answer();
    }) as typeof globalThis.fetch;
    return { fetch, calls };
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const file = (bytes: number[], type = "image/png") => () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });

describe("downloadMedia", () => {
    it("downloads over https without credentials and follows safe redirects by hand", async () => {
        const { fetch, calls } = fetchScript({ "https://cdn.example/a.png": redirect("/b.png"), "https://cdn.example/b.png": file([1, 2, 3], "image/png; charset=x") });
        expect(await downloadMedia("https://cdn.example/a.png", { fetch })).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
        expect(calls.map((c) => [c.init.credentials, c.init.redirect])).toEqual([["omit", "manual"], ["omit", "manual"]]);
    });

    it("refuses redirects to http, loopback, private, or link-local addresses, and too many hops", async () => {
        for (const location of ["http://cdn.example/b.png", "https://127.0.0.1:4319/mcp", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://[::1]/x"]) {
            const { fetch, calls } = fetchScript({ "https://cdn.example/a.png": redirect(location) });
            await expect(downloadMedia("https://cdn.example/a.png", { fetch })).rejects.toThrow(/https|private/);
            expect(calls).toHaveLength(1);
        }
        const loop = fetchScript({ "https://cdn.example/a": redirect("https://cdn.example/a") });
        await expect(downloadMedia("https://cdn.example/a", { fetch: loop.fetch })).rejects.toThrow(/too often/);
    });

    it("caps the size while streaming, even without Content-Length", async () => {
        const { fetch } = fetchScript({ "https://cdn.example/big": () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); } }), { status: 200 }) });
        await expect(downloadMedia("https://cdn.example/big", { fetch, maxBytes: 10 })).rejects.toThrow(/too large/);
    });

    it("times out", async () => {
        const fetch = ((_url: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        })) as typeof globalThis.fetch;
        await expect(downloadMedia("https://cdn.example/slow", { fetch, timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("allows plain http only to loopback, only when asked", () => {
        expect(() => checkDownloadUrl("http://127.0.0.1:4320/files/a.png")).toThrow(/https/);
        expect(checkDownloadUrl("http://127.0.0.1:4320/files/a.png", true).href).toBe("http://127.0.0.1:4320/files/a.png");
        expect(() => checkDownloadUrl("http://10.0.0.1/a", true)).toThrow(/https/);
        expect(() => checkDownloadUrl("https://u:p@cdn.example/a")).toThrow(/credentials/);
        expect(isPrivateHost("192.168.1.2")).toBe(true);
        expect(isPrivateHost("172.20.0.1")).toBe(true);
        expect(isPrivateHost("cdn.opennan.com")).toBe(false);
        expect(isPrivateHost("8.8.8.8")).toBe(false);
    });
});

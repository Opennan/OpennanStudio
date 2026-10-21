import { cspMetaTag, studioCsp } from "./csp";

const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `))!.split(" ").slice(1);

describe("studioCsp", () => {
    it("allows the production API and media hosts, nothing on loopback", () => {
        const policy = studioCsp({ apiBase: "https://api.opennan.com" });
        expect(directive(policy, "connect-src")).toEqual([
            "'self'", "blob:", "data:", "https://api.opennan.com", "https://*.opennan.com", "https://queue.fal.run", "https://*.fal.media", "https://fal.media",
            "https://*.r2.cloudflarestorage.com", "https://rest.alpha.fal.ai",
        ]);
        expect(policy).not.toMatch(/localhost|127\.0\.0\.1/);
        expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
        expect(directive(policy, "script-src")).not.toContain("https:");
        expect(directive(policy, "object-src")).toEqual(["'none'"]);
        expect(directive(policy, "frame-src")).toEqual(["'none'"]);
        expect(directive(policy, "base-uri")).toEqual(["'none'"]);
    });

    it("adds the e2e fake server and a remote ffmpeg core host", () => {
        const policy = studioCsp({ apiBase: "http://127.0.0.1:4320", ffmpegCoreBase: "https://cdn.example.com/ffmpeg-core/" });
        expect(directive(policy, "connect-src")).toContain("http://127.0.0.1:4320");
        expect(directive(policy, "connect-src")).toContain("https://cdn.example.com");
        expect(studioCsp({ apiBase: "https://api.opennan.com", ffmpegCoreBase: "./ffmpeg-core" })).toBe(studioCsp({ apiBase: "https://api.opennan.com" }));
    });

    it("lets AI tools upload the user's media: OpenNan's presigned R2 PUT and fal.ai storage (phase 11), never plain http", () => {
        const connect = directive(studioCsp({ apiBase: "https://api.opennan.com" }), "connect-src");
        expect(connect).toContain("https://*.r2.cloudflarestorage.com");
        expect(connect).toContain("https://rest.alpha.fal.ai");
        expect(connect.filter((source) => source.startsWith("http:"))).toEqual([]);
    });

    it("renders a meta tag", () => {
        expect(cspMetaTag("default-src 'self'")).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />`);
    });
});

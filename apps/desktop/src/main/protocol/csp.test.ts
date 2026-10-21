import fs from "node:fs";
import path from "node:path";
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, META_CONTENT_SECURITY_POLICY } from "./csp";

const directives = (policy: string) =>
    Object.fromEntries(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

describe("content security policy", () => {
    it("allows only the app, its media scheme, and local data", () => {
        const d = directives(CONTENT_SECURITY_POLICY);
        expect(d["default-src"]).toEqual(["'self'"]);
        expect(d["script-src"]).toEqual(["'self'", "'unsafe-eval'"]);
        expect(d["object-src"]).toEqual(["'none'"]);
        expect(d["frame-ancestors"]).toEqual(["'none'"]);
        expect(d["media-src"]).toEqual(["'self'", "blob:", "opennan-media:"]);
        expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*|wss?:/);
        expect(d["script-src"]).not.toContain("'unsafe-inline'");
        expect(APP_ORIGIN).toBe("opennan-app://app");
    });

    it("matches the meta tag of the renderer page", () => {
        const html = fs.readFileSync(path.resolve(__dirname, "../../renderer/index.html"), "utf8");
        const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
        expect(meta?.[1]).toBe(META_CONTENT_SECURITY_POLICY);
        expect(META_CONTENT_SECURITY_POLICY).not.toContain("frame-ancestors");
    });
});

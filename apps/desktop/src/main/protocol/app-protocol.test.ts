import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppProtocolHandler } from "./app-protocol";
import { CONTENT_SECURITY_POLICY } from "./csp";

describe("opennan-app protocol", () => {
    let dir: string;
    let dist: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-app-"));
        dist = path.join(dir, "renderer");
        fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
        fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>");
        fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)");
        fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("serves files from the renderer folder with type, CSP, and nosniff", async () => {
        const handler = createAppProtocolHandler(dist);
        const res = await handler(new Request("opennan-app://app/index.html"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).toBe("<!doctype html>");
        expect((await handler(new Request("opennan-app://app/"))).status).toBe(200);
        expect((await handler(new Request("opennan-app://app/assets/app.js"))).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    });

    it.each([
        "opennan-app://app/../secret.txt", "opennan-app://app/%2e%2e/secret.txt", "opennan-app://app/assets/..%2f..%2fsecret.txt",
        "opennan-app://app/%5c..%5csecret.txt", "opennan-app://app/%2e%2e%5csecret.txt", "opennan-app://app/assets%00/app.js",
        "opennan-app://other/index.html", "opennan-app://app/missing.js", "opennan-app://app/assets", "opennan-app://app/%E0%A4%A",
    ])("refuses %s", async (url) => {
        expect((await createAppProtocolHandler(dist)(new Request(url))).status).toBe(404);
    });

    it.skipIf(process.platform === "win32")("refuses a symlink that leaves the folder", async () => {
        fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dist, "link.txt"));
        expect((await createAppProtocolHandler(dist)(new Request("opennan-app://app/link.txt"))).status).toBe(404);
    });

    it("refuses methods other than GET and HEAD", async () => {
        const handler = createAppProtocolHandler(dist);
        expect((await handler(new Request("opennan-app://app/index.html", { method: "POST", body: "x" }))).status).toBe(405);
        const head = await handler(new Request("opennan-app://app/index.html", { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
    });
});

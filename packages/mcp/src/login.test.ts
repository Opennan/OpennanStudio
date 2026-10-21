// opennan-studio login | whoami | logout and the generation tools of `mcp serve`, against the fake OpenNan server.
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runCli, type CliIo } from "./cli";
import { printable } from "./login";
import { credentialsPath } from "./credentials";
import { readProjectFile, writeProjectFile } from "./project-file";
import { fixtureProject } from "./testing/fixture";

let fake: FakeOpenNan;
let dir: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(async () => {
    fake.reset();
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-login-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function io(env: Record<string, string | undefined> = {}, waitForShutdown: () => Promise<void> = async () => undefined) {
    const out: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const value: CliIo = {
        stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: dir, home: path.join(dir, "home"), env: { DISPLAY: ":0", ...env },
        nodePath: "/usr/bin/node", cliPath: "/opt/cli.js", waitForShutdown, openUrl: (url) => (opened.push(url), true),
    };
    return { io: value, out, err, opened, text: () => out.join("") + err.join("") };
}

async function approveWhenWaiting() {
    await vi.waitFor(() => expect(fake.state().latestUserCode).not.toBeNull(), { timeout: 5000 });
    fake.approve(fake.state().latestUserCode!);
}

describe("opennan-studio login, whoami, logout", () => {
    it("signs in with the device flow, saves the key 0600 without printing it, and opens the browser", async () => {
        const run = io();
        const pending = runCli(["login", "--api", fake.url], run.io);
        await approveWhenWaiting();
        expect(await pending).toBe(0);
        const text = run.text();
        expect(text).toMatch(new RegExp(`Open ${fake.url.replace(/[.]/g, "\\.")}/console/device\\?code=[A-Z]{4}-[A-Z]{4}`));
        expect(text).toContain("Opened your browser.");
        expect(text).toContain("Signed in as ada@example.com · Credits $12.40");
        expect(text).not.toMatch(/sk-/);
        expect(run.opened).toHaveLength(1);
        expect(fake.state().devices[0]).toMatchObject({ client: "cli", deviceName: expect.stringMatching(/^CLI · /) });
        const file = credentialsPath(run.io.env, run.io.home, process.platform);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ apiKey: expect.stringMatching(/^sk-fake_/), apiBase: fake.url });

        const who = io();
        expect(await runCli(["whoami"], who.io)).toBe(0);
        expect(who.text()).toContain("ada@example.com (Ada Lovelace) · Credits $12.40");
        expect(who.text()).not.toMatch(/sk-/);

        const again = io();
        expect(await runCli(["login"], again.io)).toBe(0);
        expect(again.text()).toContain("Already signed in as ada@example.com");

        const out = io();
        expect(await runCli(["logout"], out.io)).toBe(0);
        expect(out.text()).toContain("Signed out. The key was revoked.");
        expect(fake.state().revokedKeyIds).toHaveLength(1);
        const after = io();
        expect(await runCli(["whoami"], after.io)).toBe(1);
        expect(after.text()).toContain("Not signed in. Run `opennan-studio login`.");
        expect(await runCli(["logout"], io().io)).toBe(0);
    });

    it("does not open a browser with --no-browser or over SSH", async () => {
        const quiet = io({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 5000" });
        const pending = runCli(["login", "--api", fake.url], quiet.io);
        await approveWhenWaiting();
        expect(await pending).toBe(0);
        expect(quiet.opened).toEqual([]);
        expect(quiet.text()).not.toContain("Opened your browser.");
    });

    it("sends a saved key only to the API it came from, whatever --api or OPENNAN_API_BASE say", async () => {
        const run = io();
        const pending = runCli(["login", "--api", fake.url, "--no-browser"], run.io);
        await approveWhenWaiting();
        expect(await pending).toBe(0);
        const elsewhere = await startFakeOpenNan();
        try {
            const who = io({ OPENNAN_API_BASE: elsewhere.url });
            expect(await runCli(["whoami", "--api", elsewhere.url], who.io)).toBe(0);
            expect(elsewhere.state().requests).toEqual([]);
            expect(fake.state().requests.some((r) => r.path === "/v1/account")).toBe(true);
            const out = io({ OPENNAN_API_BASE: elsewhere.url });
            expect(await runCli(["logout", "--api", elsewhere.url], out.io)).toBe(0);
            expect(elsewhere.state().requests).toEqual([]);
            expect(fake.state().revokedKeyIds).toHaveLength(1);
        } finally {
            await elsewhere.close();
        }
    });

    it("strips terminal escape sequences from server text", () => {
        expect(printable("ada\u001b]8;;https://evil\u0007@example.com\r\n")).toBe("ada]8;;https://evil@example.com");
        expect(printable(null)).toBe("");
    });

    it("refuses a plain-http API that is not loopback", async () => {
        const run = io();
        expect(await runCli(["login", "--api", "http://api.example.com"], run.io)).toBe(2);
        expect(run.text()).toContain("--api must be an https URL");
    });

    it("uses OPENNAN_API_KEY over the file", async () => {
        const key = fake.mintKey();
        const run = io({ OPENNAN_API_KEY: key, OPENNAN_API_BASE: fake.url });
        expect(await runCli(["whoami"], run.io)).toBe(0);
        expect(run.text()).toContain("(from OPENNAN_API_KEY)");
        expect(run.text()).not.toContain(key);
        const out = io({ OPENNAN_API_KEY: key });
        expect(await runCli(["logout"], out.io)).toBe(0);
        expect(out.text()).toContain("OPENNAN_API_KEY is set");
    });

    it("reports a denied sign-in", async () => {
        const run = io();
        const pending = runCli(["login", "--api", fake.url, "--no-browser"], run.io);
        await vi.waitFor(() => expect(fake.state().latestUserCode).not.toBeNull(), { timeout: 5000 });
        fake.deny(fake.state().latestUserCode!);
        expect(await pending).toBe(1);
        expect(run.text()).toContain("Not signed in: Sign-in was denied.");
    });

    it("mcp serve uses the signed-in account for generation tools", async () => {
        const run = io();
        const pending = runCli(["login", "--api", fake.url, "--no-browser"], run.io);
        await approveWhenWaiting();
        expect(await pending).toBe(0);
        const file = path.join(dir, "film.opennan.json");
        await writeProjectFile(file, fixtureProject());
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => {
            stop = resolve;
        });
        const serve = io({}, () => stopped);
        const running = runCli(["mcp", "serve", "--project", file, "--http", "--port", "0"], serve.io);
        await vi.waitFor(() => expect(serve.out.length).toBe(2), { timeout: 10_000 });
        const url = serve.out[0]!.trim().replace("OPENNAN_STUDIO_MCP_URL=", "");
        const token = (await readFile(`${file}.mcp-token`, "utf8")).trim();
        const client = new Client({ name: "login-test", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        const result = await client.callTool({ name: "generate_quick_image", arguments: { prompt: "a lighthouse" } }) as { isError?: boolean; content: Array<{ text?: string }> };
        expect(result.isError).toBe(false);
        expect(result.content[0]!.text).toMatch(/^Added to the media library: image opennan-local:\/\/media\//);
        await client.close();
        stop();
        expect(await running).toBe(0);
        expect((await readProjectFile(file)).project.library).toHaveLength(1);
    });
});

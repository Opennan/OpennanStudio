import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { credentialsPath, deleteCredentials, envCredentialStore, fileCredentialStore, readCredentials, writeCredentials } from "./credentials";
import { browserCommand, isOpenableUrl, openBrowser, shouldOpenBrowser } from "./open-browser";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-cred-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("CLI credentials", () => {
    it("lives in the platform's config folder", () => {
        expect(credentialsPath({}, "/home/ada", "linux")).toBe("/home/ada/.config/opennan-studio/credentials.json");
        expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/ada", "linux")).toBe("/xdg/opennan-studio/credentials.json");
        expect(credentialsPath({ XDG_CONFIG_HOME: "relative" }, "/home/ada", "darwin")).toBe("/home/ada/.config/opennan-studio/credentials.json");
        expect(credentialsPath({ APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, "C:\\Users\\ada", "win32")).toMatch(/opennan-studio[\\/]credentials\.json$/);
    });

    it("writes the folder 0700 and the file 0600, reads it back, and deletes it", async () => {
        const file = path.join(dir, "config", "opennan-studio", "credentials.json");
        await writeCredentials(file, { apiKey: "sk-test_abcdefghijklmnopqrstuvwxyz", keyId: "key_1", expiresAt: null });
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        expect(await readCredentials(file)).toEqual({ apiKey: "sk-test_abcdefghijklmnopqrstuvwxyz", keyId: "key_1", expiresAt: null });
        await writeFile(file, "{damaged");
        expect(await readCredentials(file)).toBeNull();
        expect(await deleteCredentials(file)).toBe(true);
        expect(await readCredentials(file)).toBeNull();
    });

    it("makes an existing config folder private and refuses a symlinked one", async () => {
        const folder = path.join(dir, "existing");
        await mkdir(folder, { mode: 0o755 });
        await writeCredentials(path.join(folder, "credentials.json"), { apiKey: "sk-x", keyId: "k" });
        expect((await stat(folder)).mode & 0o777).toBe(0o700);
        const real = path.join(dir, "real");
        await mkdir(real);
        await symlink(real, path.join(dir, "linked"));
        await expect(writeCredentials(path.join(dir, "linked", "credentials.json"), { apiKey: "sk-x", keyId: "k" })).rejects.toThrow(/symlink/);
    });

    it("refuses to write through a symlink", async () => {
        const target = path.join(dir, "elsewhere.json");
        await writeFile(target, "x");
        const file = path.join(dir, "credentials.json");
        await symlink(target, file);
        await expect(writeCredentials(file, { apiKey: "sk-x", keyId: "k" })).rejects.toThrow(/symlink/);
        expect(await readFile(target, "utf8")).toBe("x");
    });

    it("stores through a CredentialStore and keeps the API base", async () => {
        const file = path.join(dir, "c.json");
        const store = fileCredentialStore(file, "http://127.0.0.1:4320");
        await store.set({ apiKey: "sk-a", keyId: "k" });
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ apiKey: "sk-a", keyId: "k", apiBase: "http://127.0.0.1:4320" });
        await store.clear();
        expect(await store.get()).toBeNull();
        const env = envCredentialStore(" sk-env ");
        expect(await env.get()).toEqual({ apiKey: "sk-env", keyId: "env" });
        await env.clear();
        expect(await env.get()).not.toBeNull();
        await mkdir(path.join(dir, "x"));
    });
});

describe("opening the browser", () => {
    it("skips SSH sessions, headless Linux, and --no-browser", () => {
        expect(shouldOpenBrowser({}, "darwin")).toBe(true);
        expect(shouldOpenBrowser({}, "darwin", true)).toBe(false);
        expect(shouldOpenBrowser({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false);
        expect(shouldOpenBrowser({}, "linux")).toBe(false);
        expect(shouldOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    });

    it("spawns an argv opener only for https or loopback URLs", () => {
        expect(browserCommand("https://opennan.com/console/device?code=AB&signup=1", "darwin")).toEqual({ command: "open", args: ["https://opennan.com/console/device?code=AB&signup=1"] });
        expect(browserCommand("https://x/?a=1&b=2", "linux")).toEqual({ command: "xdg-open", args: ["https://x/?a=1&b=2"] });
        expect(browserCommand("https://x/?a=1&b=2", "win32").args.at(-1)).toBe("https://x/?a=1^&b=2");
        expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
        expect(isOpenableUrl("http://evil.example")).toBe(false);
        const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
        expect(openBrowser("javascript:alert(1)", { platform: "darwin", spawn })).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
        expect(openBrowser("https://opennan.com/console/device", { platform: "darwin", spawn })).toBe(true);
        expect(spawn).toHaveBeenCalledWith("open", ["https://opennan.com/console/device"], expect.objectContaining({ shell: false }));
    });
});

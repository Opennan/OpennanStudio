import { EventEmitter } from "node:events";
import { forbiddenDebugSwitches, hardenContents, isSafeExternalUrl, lockPermissions, permissionAllowed, windowOptions, type WebContentsLike } from "./window";

function fakeContents() {
    const emitter = new EventEmitter();
    let openHandler: ((details: { url: string }) => { action: string }) | null = null;
    const contents = {
        on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
        setWindowOpenHandler: (handler: typeof openHandler) => {
            openHandler = handler;
        },
    } as unknown as WebContentsLike;
    const fire = (event: string, url?: string) => {
        const e = { prevented: false, preventDefault() { this.prevented = true; } };
        emitter.emit(event, e, url);
        return e.prevented;
    };
    return { contents, fire, open: (url: string) => openHandler!({ url }) };
}

describe("window hardening", () => {
    it("locks the renderer's web preferences", () => {
        const prefs = windowOptions("/app/preload.cjs", ["--opennan-e2e"]).webPreferences!;
        expect(prefs).toMatchObject({
            preload: "/app/preload.cjs", contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
            navigateOnDragDrop: false, additionalArguments: ["--opennan-e2e"],
        });
    });

    it("keeps navigation inside the app", () => {
        const { contents, fire } = fakeContents();
        hardenContents(contents, vi.fn());
        expect(fire("will-navigate", "https://evil.test/")).toBe(true);
        expect(fire("will-navigate", "file:///etc/passwd")).toBe(true);
        expect(fire("will-redirect", "opennan-media://blob/x")).toBe(true);
        expect(fire("will-navigate", "opennan-app://app/index.html#/p/x")).toBe(false);
        expect(fire("will-attach-webview")).toBe(true);
    });

    it("denies new windows and opens only https links externally", () => {
        const { contents, open } = fakeContents();
        const openExternal = vi.fn();
        hardenContents(contents, openExternal);
        expect(open("https://example.com/docs")).toEqual({ action: "deny" });
        expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://example.com", "https://user:pw@example.com", "smb://host/share"]) {
            expect(open(url)).toEqual({ action: "deny" });
        }
        expect(openExternal).toHaveBeenCalledTimes(1);
        expect(isSafeExternalUrl("https://opennan.com")).toBe(true);
    });

    it("grants only clipboard writes and fullscreen", () => {
        for (const permission of ["media", "geolocation", "notifications", "openExternal", "midi", "clipboard-read", "hid", "serial"]) {
            expect(permissionAllowed(permission)).toBe(false);
        }
        expect(permissionAllowed("clipboard-sanitized-write")).toBe(true);
        let request: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null;
        lockPermissions({ setPermissionRequestHandler: (h) => { request = h; }, setPermissionCheckHandler: vi.fn() });
        const callback = vi.fn();
        request!(null, "media", callback);
        expect(callback).toHaveBeenCalledWith(false);
    });
});

describe("debugging switches", () => {
    it("finds remote debugging and inspector switches", () => {
        expect(forbiddenDebugSwitches(["/app"], () => false)).toEqual([]);
        expect(forbiddenDebugSwitches(["/app", "--remote-debugging-port=9222"], (name) => name === "remote-debugging-port")).toEqual(["remote-debugging-port", "--remote-debugging-port"]);
        expect(forbiddenDebugSwitches(["/app", "--inspect-brk=0"], () => false)).toEqual(["--inspect-brk"]);
        expect(forbiddenDebugSwitches(["/app", "--mcp-bridge"], () => false)).toEqual([]);
    });
});

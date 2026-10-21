// The Share dialog (phase 9c): a local project's prompt sends nothing; a cloud project's active link, its views and
// Copy; the nothing-to-show offer; every message key exists; theme tokens only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { en } from "@opennan/timeline-react";
import { ProviderRegistry } from "@opennan/provider-sdk";
import type { CloudApi, CloudMethod, CloudRequest } from "@opennan/cloud-backend";
import css from "./share.css?raw";
import { AccountProvider } from "../account/account-context";
import { signedOutAccount } from "../account/account-types";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import { ShareDialog, shareErrorText, type ShareT } from "./share-dialog";
import { ShareHost } from "./share-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES = import.meta.glob<string>(["./*.{ts,tsx}", "../editor/*.tsx"], { query: "?raw", import: "default", eager: true });
const MESSAGES = (en as unknown as Record<string, Record<string, string>>).share!;
const t: ShareT = (key, values) => {
    const raw = MESSAGES[key];
    if (raw === undefined) throw new Error(`missing share.${key}`);
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
};
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";

async function mount(element: ReturnType<typeof createElement>) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const runtime = { cloud: { backend: () => null, peek: () => null, subscribe: () => () => undefined }, account: signedOutAccount() } as unknown as StudioRuntime;
    const account = createElement(AccountProvider, { account: signedOutAccount(), providers: new ProviderRegistry(), children: element });
    await act(async () => root.render(createElement(StudioRuntimeProvider, { runtime, children: account })));
    return { root, unmount: () => act(() => root.unmount()) };
}

function stubHost(answer: (method: CloudMethod, path: string) => unknown, extra: Partial<ConstructorParameters<typeof ShareHost>[0]> = {}) {
    const calls: string[] = [];
    const copied: string[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, _request?: CloudRequest) {
            calls.push(`${method} ${path}`);
            return { status: 200, body: answer(method, path) as T, etag: null };
        },
    };
    const host = new ShareHost({ api, serverId: "p1", site: {}, isSignedIn: () => true, openSignIn: async () => false, clipboard: async (text) => void copied.push(text), ...extra });
    return { host, calls, copied };
}

describe("the Share dialog", () => {
    it("a local project asks to save to OpenNan and sends nothing", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const view = await mount(createElement(ShareDialog, { projectId: "local-1", projectName: "Trip", host: null, onClose: () => undefined }));
        const local = document.querySelector("[data-testid=share-local]");
        expect(local?.textContent).toContain("Sharing needs a cloud project");
        expect([...document.querySelectorAll(".share-dialog button")].map((b) => b.textContent)).toContain("Save to OpenNan");
        expect(fetchSpy).not.toHaveBeenCalled();
        view.unmount();
        fetchSpy.mockRestore();
    });

    it("shows the active link, its views and options, and copies it", async () => {
        const { host, copied } = stubHost(() => ({ object: "list", data: [{ id: "shr_aaaaaaaaaaaaaaaaaaaaaaaa", token: TOKEN, url: `https://opennan.com/s/${TOKEN}`, status: "active", allow_download: true, expires_at: "2026-11-20T10:00:00Z", views: 3, last_viewed_at: null }] }));
        const view = await mount(createElement(ShareDialog, { projectId: "cloud-p1", projectName: "Trip", host, onClose: () => undefined }));
        await act(async () => undefined);
        const input = document.querySelector<HTMLInputElement>("#share-link-url")!;
        expect(input.value).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(input.readOnly).toBe(true);
        expect(document.querySelector("[data-testid=share-views]")?.textContent).toContain("3 views");
        expect(document.querySelector("[data-testid=share-views]")?.textContent).toContain("Not viewed yet");
        expect(document.querySelector("[data-testid=share-link]")?.textContent).toContain("Viewers can download");
        await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=share-copy]")!.click());
        expect(copied).toEqual([`https://opennan.com/s/${TOKEN}`]);
        expect(document.querySelector("[data-testid=share-copy]")?.textContent).toContain("Link copied");
        view.unmount();
        host.dispose();
    });

    it("offers Export and share when the project has nothing to show (and where the host can export)", async () => {
        const { host } = stubHost((method) => {
            if (method === "POST") throw Object.assign(new Error("x"), { name: "CloudApiError", status: 409, code: "share_nothing_to_show", fromServer: true });
            return { object: "list", data: [] };
        }, { exportVideo: async () => ({}) as never, uploadExport: async () => ({ mediaUrl: "x" }), setFinalVideo: async () => undefined });
        const view = await mount(createElement(ShareDialog, { projectId: "cloud-p1", projectName: "Trip", host, onClose: () => undefined }));
        await act(async () => undefined);
        await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".share-dialog button")].find((b) => b.textContent === "Create link")!.click());
        expect(document.querySelector("[data-testid=share-nothing]")?.textContent).toContain("Nothing to show yet");
        expect([...document.querySelectorAll(".share-dialog button")].map((b) => b.textContent)).toContain("Export and share");
        view.unmount();
        host.dispose();
    });

    it("a cloud project while signed out asks to sign in (never Save to OpenNan)", async () => {
        const view = await mount(createElement(ShareDialog, { projectId: "cloud-p1", projectName: "Trip", host: null, onClose: () => undefined }));
        expect(document.querySelector("[data-testid=share-signin]")?.textContent).toContain("Sign in");
        expect([...document.querySelectorAll(".share-dialog button")].map((b) => b.textContent)).not.toContain("Save to OpenNan");
        view.unmount();
    });

    it("a failed read offers Try again", async () => {
        const { host } = stubHost(() => { throw Object.assign(new Error("x"), { name: "CloudApiError", status: 0, code: "network" }); });
        const view = await mount(createElement(ShareDialog, { projectId: "cloud-p1", projectName: "Trip", host, onClose: () => undefined }));
        await act(async () => undefined);
        expect([...document.querySelectorAll(".share-dialog button")].map((b) => b.textContent)).toContain("Try again");
        view.unmount();
        host.dispose();
    });

    it("has words for every refusal", () => {
        const codes = ["limit", "rate_limited", "signed_out", "not_found", "network", "server", "copy_failed", "export_failed", "upload_failed", "storage_full", "final_video_refused"] as const;
        const texts = codes.map((code) => shareErrorText(t, { code }));
        expect(new Set(texts).size).toBe(codes.length);
        expect(shareErrorText(t, { code: "rate_limited", retryAfterSeconds: 90 })).toBe("Too many links made: try again in 90 s.");
    });

    it("every share key the components use exists", () => {
        const missing: string[] = [];
        for (const [name, code] of Object.entries(SOURCES)) {
            if (name.endsWith(".test.ts")) continue;
            for (const [, fn] of code.matchAll(/const\s+(\w+)\s*=\s*useTimelineMessages\(\s*"share"\s*\)/g)) {
                for (const [, key] of code.matchAll(new RegExp(`\\b${fn}\\(\\s*"([A-Za-z0-9_]+)"`, "g"))) if (!(key! in MESSAGES)) missing.push(`${name}: ${key}`);
            }
        }
        expect(missing).toEqual([]);
        // Keys passed through maps (day labels, steps) exist too.
        for (const key of ["day1", "days7", "days30", "days90", "days365", "daysN", "stepExport", "stepUpload", "stepSaving", "stepLink"]) expect(MESSAGES[key], key).toBeDefined();
    });

    it("share.css uses theme tokens only", () => {
        expect(css.length).toBeGreaterThan(500);
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});

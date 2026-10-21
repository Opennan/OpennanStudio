import { getTool } from "@opennan/mcp-schema";
import type { StudioCloud, StudioSession } from "../session";
import { toolCallHistory } from "../tool-calls";
import { CLOUD_HANDLERS, SHARE_DECLINED, SHARE_NEEDS_APP, SHARE_UNANSWERED, ShareNotAllowedError } from "./cloud";

function context(cloud?: StudioCloud) {
    const session = { projectId: "local-1", host: {}, ...(cloud ? { cloud } : {}) } as unknown as StudioSession;
    return (name: string) => ({ session, tool: getTool(name)!, history: toolCallHistory(session), signal: new AbortController().signal });
}

const project = { id: "cloud-p1", name: "Trip", aspectRatio: "9:16", durationSeconds: 72, mediaBytes: 1_200_000_000, updatedAt: Date.UTC(2026, 9, 20), lastEditedDevice: "MacBook", origin: "studio" as const, deletedAt: null };

describe("cloud tool handlers", () => {
    it("answer that headless hosts have no cloud projects", async () => {
        const ctx = context();
        for (const name of Object.keys(CLOUD_HANDLERS).filter((n) => n !== "create_share_link")) {
            const outcome = await CLOUD_HANDLERS[name]!({}, ctx(name));
            expect(outcome).toMatchObject({ ok: false, unavailable: { reason: expect.stringContaining("OpenNan cloud projects") } });
        }
        // Headless `mcp serve` has no window to ask the person in: a public link is refused there (9c.1).
        expect(await CLOUD_HANDLERS.create_share_link!({}, ctx("create_share_link"))).toMatchObject({ ok: false, unavailable: { reason: SHARE_NEEDS_APP } });
        expect(SHARE_NEEDS_APP).toMatch(/needs the OpenNan Studio app.*asks you.*headless/);
    });

    it("list the account's projects with paging", async () => {
        const listProjects = vi.fn(async () => ({ projects: [project], nextCursor: "c2" }));
        const ctx = context({ listProjects } as unknown as StudioCloud);
        const outcome = await CLOUD_HANDLERS.list_cloud_projects!({ trash: true, cursor: "c1" }, ctx("list_cloud_projects"));
        expect(listProjects).toHaveBeenCalledWith({ trash: true, cursor: "c1" });
        expect(outcome).toMatchObject({ ok: true, data: { projects: [{ id: "cloud-p1", name: "Trip", last_edited_device: "MacBook" }], next_cursor: "c2" } });
        expect((outcome as { text: string }).text).toContain("Trip");
    });

    it("save, open, and report sync status", async () => {
        const cloud = {
            saveCurrentProject: vi.fn(async () => ({ projectId: "cloud-p9", name: "Trip" })),
            openProject: vi.fn(async (id: string) => ({ projectId: id, name: "Trip" })),
            syncStatus: vi.fn(async () => ({ projectId: "cloud-p9", state: "offline", label: "Offline (2 pending)", pending: 2, conflicts: [] })),
        } as unknown as StudioCloud;
        const ctx = context(cloud);
        expect(await CLOUD_HANDLERS.save_project_to_cloud!({}, ctx("save_project_to_cloud"))).toMatchObject({ ok: true, data: { project_id: "cloud-p9" } });
        expect(await CLOUD_HANDLERS.open_cloud_project!({ project_id: "cloud-p9" }, ctx("open_cloud_project"))).toMatchObject({ ok: true, data: { project_id: "cloud-p9" } });
        expect(await CLOUD_HANDLERS.open_cloud_project!({ project_id: "local-1" }, ctx("open_cloud_project"))).toMatchObject({ ok: false });
        expect(await CLOUD_HANDLERS.get_cloud_sync_status!({}, ctx("get_cloud_sync_status"))).toMatchObject({ ok: true, data: { state: "offline", pending: 2 } });
    });

    it("turns a refusal into a failure with its message", async () => {
        const ctx = context({ saveCurrentProject: async () => { throw new Error("Not enough cloud storage: 0 B left."); } } as unknown as StudioCloud);
        expect(await CLOUD_HANDLERS.save_project_to_cloud!({}, ctx("save_project_to_cloud"))).toMatchObject({ ok: false, text: "Not enough cloud storage: 0 B left." });
    });

    describe("share links (phase 9c)", () => {
        const TOKEN_URL = "https://opennan.com/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
        const shareLink = (overrides: Record<string, unknown> = {}) => ({
            id: "shr_0123456789abcdef01234567", url: TOKEN_URL, status: "active", allowDownload: false, expiresAt: Date.UTC(2026, 10, 20), createdAt: Date.UTC(2026, 9, 21),
            revokedAt: null, views: 4, lastViewedAt: Date.UTC(2026, 9, 21, 12), ...overrides,
        });
        function cloudContext(projectId: string, shares?: Record<string, unknown>) {
            const cloud = { ...(shares ? { shares } : {}) } as unknown as StudioCloud;
            const session = { projectId, host: {}, cloud } as unknown as StudioSession;
            return (name: string) => ({ session, tool: getTool(name)!, history: toolCallHistory(session), signal: new AbortController().signal });
        }

        it("creates a link with the options and answers it to give to people", async () => {
            const create = vi.fn(async () => shareLink({ allowDownload: true }));
            const ctx = cloudContext("cloud-p1", { create, list: vi.fn(), revoke: vi.fn() });
            const outcome = await CLOUD_HANDLERS.create_share_link!({ expires_in_days: 7, allow_download: true }, ctx("create_share_link"));
            // The call's signal goes with it: a call the client stops closes the person's question (review 9c.1).
            expect(create).toHaveBeenCalledWith({ expiresInDays: 7, allowDownload: true }, { signal: expect.any(AbortSignal) });
            expect(outcome).toMatchObject({ ok: true, data: { share_id: "shr_0123456789abcdef01234567", url: TOKEN_URL, status: "active", allow_download: true, views: 4 } });
            expect((outcome as { text: string }).text).toContain(TOKEN_URL);
            expect((outcome as { text: string }).text).toMatch(/view only/i);
            await CLOUD_HANDLERS.create_share_link!({}, ctx("create_share_link"));
            expect(create).toHaveBeenLastCalledWith({}, { signal: expect.any(AbortSignal) });
        });

        it("lists links (only the active one carries its link) and turns one off or all", async () => {
            const list = vi.fn(async () => [shareLink(), shareLink({ id: "shr_aaaaaaaaaaaaaaaaaaaaaaaa", url: null, status: "revoked", revokedAt: Date.UTC(2026, 9, 20) })]);
            const revoke = vi.fn(async () => [shareLink({ status: "revoked", url: null })]);
            const ctx = cloudContext("cloud-p1", { create: vi.fn(), list, revoke });
            const listed = await CLOUD_HANDLERS.list_share_links!({}, ctx("list_share_links"));
            expect(listed).toMatchObject({ ok: true, data: { links: [{ status: "active", url: TOKEN_URL }, { status: "revoked", url: null }] } });
            expect(await CLOUD_HANDLERS.revoke_share_link!({ share_id: "shr_0123456789abcdef01234567" }, ctx("revoke_share_link"))).toMatchObject({ ok: true, data: { links: [{ status: "revoked" }] } });
            expect(revoke).toHaveBeenLastCalledWith("shr_0123456789abcdef01234567");
            const stopped = await CLOUD_HANDLERS.revoke_share_link!({}, ctx("revoke_share_link"));
            expect(revoke).toHaveBeenLastCalledWith(undefined);
            // Stop sharing names exactly the links OpenNan turned off.
            expect((stopped as { text: string }).text).toBe("Turned off the link shr_0123456789abcdef01234567: people who have it can no longer watch.");
            const two = cloudContext("cloud-p1", { create: vi.fn(), list, revoke: vi.fn(async () => [shareLink({ status: "revoked", url: null }), shareLink({ id: "shr_aaaaaaaaaaaaaaaaaaaaaaaa", status: "revoked", url: null })]) });
            expect((await CLOUD_HANDLERS.revoke_share_link!({}, two("revoke_share_link")) as { text: string }).text).toBe("Turned off 2 links (shr_0123456789abcdef01234567, shr_aaaaaaaaaaaaaaaaaaaaaaaa): people who have them can no longer watch.");
            const none = cloudContext("cloud-p1", { create: vi.fn(), list: vi.fn(async () => []), revoke: vi.fn(async () => []) });
            expect((await CLOUD_HANDLERS.list_share_links!({}, none("list_share_links")) as { text: string }).text).toMatch(/not shared/i);
            expect((await CLOUD_HANDLERS.revoke_share_link!({}, none("revoke_share_link")) as { text: string }).text).toMatch(/no active link/i);
        });

        it("a local project is asked to be saved to OpenNan first (nothing sent); a host without shares answers unavailable", async () => {
            const create = vi.fn();
            const local = cloudContext("local-1", { create, list: create, revoke: create });
            for (const name of ["create_share_link", "list_share_links", "revoke_share_link"]) {
                const outcome = await CLOUD_HANDLERS[name]!({}, local(name));
                expect(outcome).toMatchObject({ ok: false });
                expect((outcome as { text: string }).text).toMatch(/save it to OpenNan first/);
            }
            expect(create).not.toHaveBeenCalled();
            const without = cloudContext("cloud-p1");
            expect(await CLOUD_HANDLERS.create_share_link!({}, without("create_share_link"))).toMatchObject({ ok: false, unavailable: expect.anything() });
        });

        it("refuses bad options before asking the host, and passes the host's refusal on", async () => {
            const create = vi.fn(async () => { throw new Error("This project has nothing to show yet: export it in OpenNan Studio (Share → Export and share) first."); });
            const ctx = cloudContext("cloud-p1", { create, list: vi.fn(), revoke: vi.fn() });
            expect(await CLOUD_HANDLERS.create_share_link!({ expires_in_days: 400 }, ctx("create_share_link"))).toMatchObject({ ok: false });
            expect(await CLOUD_HANDLERS.create_share_link!({ allow_download: "yes" }, ctx("create_share_link"))).toMatchObject({ ok: false });
            expect(await CLOUD_HANDLERS.revoke_share_link!({ share_id: "nope" }, ctx("revoke_share_link"))).toMatchObject({ ok: false });
            expect(create).not.toHaveBeenCalled();
            expect(await CLOUD_HANDLERS.create_share_link!({}, ctx("create_share_link"))).toMatchObject({ ok: false, text: expect.stringContaining("nothing to show") });
        });

        it("a link the person declined, or left unanswered for 2 minutes, is a clear tool error marked declined (9c.1)", async () => {
            const declined = cloudContext("cloud-p1", { create: vi.fn(async () => { throw new ShareNotAllowedError("declined"); }), list: vi.fn(), revoke: vi.fn() });
            expect(await CLOUD_HANDLERS.create_share_link!({}, declined("create_share_link"))).toEqual({ ok: false, text: SHARE_DECLINED, data: { declined: true, reason: "declined" } });
            const unanswered = cloudContext("cloud-p1", { create: vi.fn(async () => { throw new ShareNotAllowedError("unanswered"); }), list: vi.fn(), revoke: vi.fn() });
            expect(await CLOUD_HANDLERS.create_share_link!({}, unanswered("create_share_link"))).toEqual({ ok: false, text: SHARE_UNANSWERED, data: { declined: true, reason: "unanswered" } });
            expect(SHARE_DECLINED).toMatch(/declined.*no share link was made/i);
            expect(SHARE_UNANSWERED).toMatch(/2 minutes.*no share link was made/i);
        });
    });
});

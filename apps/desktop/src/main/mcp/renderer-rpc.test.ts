import { RendererTimeoutError, checkResult, createRendererRpc, type SessionRequest } from "./renderer-rpc";

const RUN = { taskId: "task_1", status: "succeeded", chargedUsd: 0.31, projectRevision: 7, synced: true, undoable: true, error: null };

describe("renderer RPC", () => {
    it("matches answers to requests", async () => {
        const sent: SessionRequest[] = [];
        const rpc = createRendererRpc({ send: (r) => sent.push(r) });
        const a = rpc.call("describeTimeline");
        const b = rpc.call("historyDepth");
        rpc.receive({ id: sent[1].id, ok: true, value: { undo: 1, redo: 0, recorded: 3, limit: 50 } });
        rpc.receive({ id: sent[0].id, ok: true, value: "2 scenes" });
        rpc.receive({ id: 999, ok: true, value: "ignored" });
        await expect(a).resolves.toBe("2 scenes");
        await expect(b).resolves.toEqual({ undo: 1, redo: 0, recorded: 3, limit: 50 });
    });

    it("passes renderer errors and refuses malformed answers", async () => {
        const sent: SessionRequest[] = [];
        const rpc = createRendererRpc({ send: (r) => sent.push(r) });
        const failed = rpc.call("execute", [{ type: "playhead.seek", seconds: 1 }]);
        rpc.receive({ id: sent[0].id, ok: false, error: "boom" });
        await expect(failed).rejects.toThrow("boom");
        const bad = rpc.call("historyDepth");
        rpc.receive({ id: sent[1].id, ok: true, value: { undo: -1, redo: 0, recorded: 0, limit: 50 } });
        await expect(bad).rejects.toThrow("unexpected value");
        const duplicate = rpc.call("describeTimeline");
        rpc.receive({ id: sent[2].id, ok: true, value: "a" });
        rpc.receive({ id: sent[2].id, ok: true, value: "b" });
        await expect(duplicate).resolves.toBe("a");
    });

    it("times out and closes", async () => {
        vi.useFakeTimers();
        const rpc = createRendererRpc({ send: () => undefined, timeoutMs: 1000 });
        const slow = rpc.call("snapshot");
        vi.advanceTimersByTime(1001);
        await expect(slow).rejects.toThrow("did not answer snapshot in 1 s");
        await expect(slow).rejects.toBeInstanceOf(RendererTimeoutError);
        const pending = rpc.call("snapshot");
        rpc.close("The editor closed the project");
        await expect(pending).rejects.toThrow("closed the project");
        await expect(rpc.call("snapshot")).rejects.toThrow("closed the project");
        vi.useRealTimers();
    });

    it("never reuses a request id across sessions, so an old editor's late answer can't settle a new session's call (review 9c.1)", async () => {
        const firstSent: SessionRequest[] = [];
        const first = createRendererRpc({ send: (r) => firstSent.push(r) });
        void first.call("confirmShare", [{}]).catch(() => undefined);
        first.close("The editor opened another project");
        const sent: SessionRequest[] = [];
        const second = createRendererRpc({ send: (r) => sent.push(r) });
        const timeline = second.call("describeTimeline");
        expect(sent[0]!.id).not.toBe(firstSent[0]!.id);
        // The old question's answer arrives at the new session: it names no call there.
        second.receive({ id: firstSent[0]!.id, ok: true, value: "timeout" });
        second.receive({ id: sent[0]!.id, ok: true, value: "2 scenes" });
        await expect(timeline).resolves.toBe("2 scenes");
    });

    it("lets one call wait longer than the default", async () => {
        vi.useFakeTimers();
        const sent: SessionRequest[] = [];
        const rpc = createRendererRpc({ send: (request) => sent.push(request), timeoutMs: 1000 });
        const long = rpc.call("execute", [{ type: "ai.run" }], { timeoutMs: 60_000 });
        vi.advanceTimersByTime(30_000);
        rpc.receive({ id: sent[0].id, ok: true, value: { ok: true, changed: {} } });
        await expect(long).resolves.toEqual({ ok: true, changed: {} });
        const late = rpc.call("execute", [{ type: "ai.run" }], { timeoutMs: 5000 });
        vi.advanceTimersByTime(5001);
        await expect(late).rejects.toThrow("did not answer execute in 5 s");
        vi.useRealTimers();
    });

    it.each([
        ["execute", { ok: true }], ["snapshot", { tracks: [], clips: [], scenes: [] }], ["describeTimeline", 42],
        ["uiState", { currentTime: "0" }], ["listEffects", {}], ["saveToLibrary", "x"],
        ["cloud.list", { projects: [{ id: "p1", name: "x" }], nextCursor: null }], ["cloud.list", { projects: [] }],
        ["cloud.save", { projectId: "local-1", name: "x" }], ["cloud.open", { projectId: "cloud-a", name: 5 }],
        ["cloud.status", { projectId: "cloud-a", state: "saved", label: "x", pending: -1, conflicts: [] }],
        ["cloud.status", { projectId: "cloud-a", state: "saved", label: "x".repeat(201), pending: 0, conflicts: [] }],
        ["cloud.quote", { kind: "quote", priceUsd: -1, holdUsd: 0 }], ["cloud.quote", { kind: "quote", priceUsd: 0.3 }], ["cloud.quote", { kind: "refused", code: "x", message: 5 }],
        ["cloud.quote", { kind: "maybe" }], ["cloud.quote", null],
        ["cloud.run", { ...RUN, status: "running" }], ["cloud.run", { ...RUN, chargedUsd: Number.NaN }], ["cloud.run", { ...RUN, projectRevision: 1.5 }],
        ["cloud.run", { ...RUN, synced: "yes" }], ["cloud.run", { ...RUN, taskId: "x".repeat(65) }], ["cloud.run", { ...RUN, error: { message: "x" } }],
        ["cloud.edit", { synced: 1 }], ["cloud.edit", null], ["cloud.script", { ok: true }],
    ] as const)("checkResult refuses a bad %s", (method, value) => {
        expect(() => checkResult(method, value)).toThrow();
    });

    it("checkResult passes the pipeline answers (phase 9b)", () => {
        expect(checkResult("cloud.quote", { kind: "quote", priceUsd: 0.31, holdUsd: 0.4 })).toEqual({ kind: "quote", priceUsd: 0.31, holdUsd: 0.4 });
        expect(checkResult("cloud.quote", { kind: "refused", code: "invalid_request", message: "No such scene." })).toMatchObject({ kind: "refused" });
        expect(checkResult("cloud.quote", { kind: "unavailable" })).toEqual({ kind: "unavailable" });
        expect(checkResult("cloud.run", RUN)).toEqual(RUN);
        expect(checkResult("cloud.run", { ...RUN, status: "failed", chargedUsd: null, projectRevision: null, error: { message: "Drawing failed.", code: null, refunded: true } })).toMatchObject({ status: "failed" });
        expect(checkResult("cloud.edit", { synced: true })).toEqual({ synced: true });
        expect(checkResult("cloud.script", null)).toBeNull();
    });
});

describe("share link answers (phase 9c)", () => {
    const link = { id: "shr_0123456789abcdef01234567", url: "https://opennan.com/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL", status: "active", allowDownload: false, expiresAt: 1, createdAt: 1, revokedAt: null, views: 0, lastViewedAt: null };
    it("takes well-formed links only", () => {
        expect(checkResult("cloud.shareCreate", link)).toEqual(link);
        expect(checkResult("cloud.shareList", [link, { ...link, url: null, status: "revoked", revokedAt: 2 }])).toBeTruthy();
        expect(checkResult("cloud.shareRevoke", [])).toEqual([]);
        expect(() => checkResult("cloud.shareCreate", { ...link, id: "x" })).toThrow();
        expect(() => checkResult("cloud.shareCreate", { ...link, url: "javascript:alert(1)" })).toThrow();
        expect(() => checkResult("cloud.shareCreate", { ...link, url: "http://evil.example/s/abc" })).toThrow();
        expect(() => checkResult("cloud.shareCreate", { ...link, url: "https://evil.example/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" })).toThrow();
        // Loopback links only against a loopback API (the e2e fake), never in production (review 9c.1).
        expect(checkResult("cloud.shareCreate", { ...link, url: "http://127.0.0.1:4320/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" }, { loopbackShares: true })).toBeTruthy();
        expect(() => checkResult("cloud.shareCreate", { ...link, url: "http://127.0.0.1:4320/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" })).toThrow();
        expect(() => checkResult("cloud.shareCreate", { ...link, views: -1 })).toThrow();
        expect(() => checkResult("cloud.shareList", Array.from({ length: 21 }, () => link))).toThrow();
    });

    it("takes links on a staging subdomain of opennan.com (share_base_url, 9c.1), never a look-alike host", () => {
        const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
        expect(checkResult("cloud.shareCreate", { ...link, url: `https://staging.opennan.com/s/${token}` })).toBeTruthy();
        for (const url of [`https://opennan.com.evil.example/s/${token}`, `https://evilopennan.com/s/${token}`, `http://staging.opennan.com/s/${token}`, `https://opennan.com:8443/s/${token}`, `https://-x.opennan.com/s/${token}`]) {
            expect(() => checkResult("cloud.shareCreate", { ...link, url })).toThrow();
        }
    });

    it("takes the person's answer to an agent's link: allow, allow for the session, deny or timeout (9c.1)", () => {
        for (const answer of ["allow", "allow-session", "deny", "timeout"]) expect(checkResult("confirmShare", answer)).toBe(answer);
        for (const bad of ["yes", true, null, undefined, { answer: "allow" }]) expect(() => checkResult("confirmShare", bad)).toThrow();
        expect(checkResult("cancelConfirmShare", undefined)).toBeUndefined();
    });
});

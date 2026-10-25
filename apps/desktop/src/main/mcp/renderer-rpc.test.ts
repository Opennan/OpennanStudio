import { RendererTimeoutError, checkResult, createRendererRpc, type SessionRequest } from "./renderer-rpc";


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
        void first.call("snapshot").catch(() => undefined);
        first.close("The editor opened another project");
        const sent: SessionRequest[] = [];
        const second = createRendererRpc({ send: (r) => sent.push(r) });
        const timeline = second.call("describeTimeline");
        expect(sent[0]!.id).not.toBe(firstSent[0]!.id);
        // The old editor's late answer arrives at the new session: it names no call there.
        second.receive({ id: firstSent[0]!.id, ok: true, value: "1 scene" });
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
    ] as const)("checkResult refuses a bad %s", (method, value) => {
        expect(() => checkResult(method, value)).toThrow();
    });

});

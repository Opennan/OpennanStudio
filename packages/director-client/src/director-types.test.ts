import { parseEvent, parseProposal, parseTurn } from "./director-types";

const base = {
    call_id: "c1", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene_id: "s1" }, quote: { price_usd: 0.3, hold_usd: 0.31 },
    request: { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", body: { model: "seedance-2" } },
};

describe("proposals (phase 9c: run by id)", () => {
    it("reads the id, the expiry, the opaque run request and the task it started", () => {
        const proposal = parseProposal({
            ...base, id: "prop_89abcdef0123456789abcdef", expires_at: "2026-10-21T10:15:00Z", task_id: "task_1",
            run: { method: "POST", path: "/v1/projects/p1/director/turns/turn_0123456789abcdef01234567/proposals/prop_89abcdef0123456789abcdef/run", body: {} },
        });
        expect(proposal).toMatchObject({
            id: "prop_89abcdef0123456789abcdef", expiresAt: Date.parse("2026-10-21T10:15:00Z"), taskId: "task_1",
            run: { method: "POST", path: "/v1/projects/p1/director/turns/turn_0123456789abcdef01234567/proposals/prop_89abcdef0123456789abcdef/run", body: {} },
            request: { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", body: { model: "seedance-2" } },
        });
    });

    it("an older server's proposal has no id, run, expiry or task", () => {
        expect(parseProposal(base)).toMatchObject({ id: null, run: null, expiresAt: null, taskId: null });
    });

    it("odd fields read as missing, never as an exception", () => {
        const proposal = parseProposal({ ...base, id: 7, expires_at: "soon", task_id: "", run: { method: "GET", path: "/x" } });
        expect(proposal).toMatchObject({ id: null, expiresAt: null, taskId: null, run: null });
        expect(parseProposal({ ...base, run: "nope" })?.run).toBeNull();
    });

    it("events and turns carry them", () => {
        const event = parseEvent("proposal", JSON.stringify({ ...base, id: "prop_89abcdef0123456789abcdef" }));
        expect(event).toMatchObject({ type: "proposal", proposal: { id: "prop_89abcdef0123456789abcdef" } });
        expect(parseTurn({ proposals: [{ ...base, task_id: "t9" }] }).proposals[0]).toMatchObject({ taskId: "t9" });
    });
});

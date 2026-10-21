// The fake OpenNan server's share links (phase 9c): the owner's routes (create / rotate, list, stop sharing, revoke
// one), the public view the share page reads (re-checked on every view, counted, short-lived media URLs, privacy
// headers), reports, the limits, and `project.final_video_url` in changesets. Each test pins one rule transcribed from
// the server's project_shares.py and changes_router.py.
import { startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
let key: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => {
    fake.reset();
    key = fake.mintKey();
});

interface Answer { status: number; body: Record<string, any>; headers: Headers }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth = true): Promise<Answer> {
    const response = await fetch(fake.url + path, {
        method,
        headers: { ...(auth ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

let serial = 0;
const change = (projectId: string, body: unknown) => call("POST", `/v1/projects/${projectId}/changes`, body, { "idempotency-key": `k-${++serial}` });
const knob = (name: string, body: unknown = {}) => fetch(`${fake.url}/__test/cloud/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const file = (name: string) => `${fake.url}/files/results/${name}`;

async function project(name = "Film", withScene = true): Promise<string> {
    const created = await call("POST", "/v1/projects", { name });
    const id = created.body.id as string;
    if (withScene) {
        const scene = crypto.randomUUID();
        expect((await change(id, { scenes: { create: [{ id: scene, start_image_url: file("a.png"), duration: 5 }] } })).status).toBe(200);
    }
    return id;
}

describe("share links: the owner's routes", () => {
    it("creates a link (201) with the server's project_share fields, 30 days and no download by default", async () => {
        const id = await project();
        const before = Date.now();
        const created = await call("POST", `/v1/projects/${id}/shares`, {});
        expect(created.status).toBe(201);
        expect(Object.keys(created.body)).toEqual(["object", "id", "project_id", "token", "url", "share_base_url", "status", "allow_download", "expires_at", "created_at", "revoked_at", "views", "last_viewed_at", "replaced"]);
        expect(created.body).toMatchObject({ object: "project_share", project_id: id, status: "active", allow_download: false, revoked_at: null, views: 0, last_viewed_at: null, replaced: [] });
        expect(created.body.id).toMatch(/^shr_[0-9a-f]{24}$/);
        expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{48}$/);
        expect(created.body.url).toBe(`${fake.url}/s/${created.body.token}`);
        expect(created.body.share_base_url).toBe(`${fake.url}/s`);
        const days = (Date.parse(created.body.expires_at) - before) / 86_400_000;
        expect(days).toBeGreaterThan(29.99);
        expect(days).toBeLessThan(30.01);
        expect(created.body.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    });

    it("takes expires_in_days 1–365 and a strict allow_download, nothing else", async () => {
        const id = await project();
        expect((await call("POST", `/v1/projects/${id}/shares`, { expires_in_days: 1, allow_download: true })).body).toMatchObject({ allow_download: true });
        for (const body of [{ expires_in_days: 0 }, { expires_in_days: 366 }, { expires_in_days: 2.5 }, { allow_download: "yes" }, { allow_download: 1 }, { password: "x" }]) {
            const refused = await call("POST", `/v1/projects/${id}/shares`, body);
            expect(refused.status, JSON.stringify(body)).toBe(400);
            expect(refused.body.error.code).toBe("invalid_request");
        }
    });

    it("rotates: a new link revokes the project's active one in the same step", async () => {
        const id = await project();
        const first = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        const second = await call("POST", `/v1/projects/${id}/shares`, { expires_in_days: 7 });
        expect(second.body.replaced).toEqual([first.id]);
        expect(second.body.token).not.toBe(first.token);
        const list = (await call("GET", `/v1/projects/${id}/shares`)).body;
        expect(list.object).toBe("list");
        expect(list.data.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([[second.body.id, "active"], [first.id, "revoked"]]);
        expect((await call("GET", `/v1/shares/${first.token}`, undefined, {}, false)).body.error.code).toBe("share_revoked");
    });

    it("refuses a project with nothing to show (409 share_nothing_to_show) until it has an export or a scene with media", async () => {
        const id = await project("Empty", false);
        const refused = await call("POST", `/v1/projects/${id}/shares`, {});
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatchObject({ type: "conflict", code: "share_nothing_to_show" });
        // A scene without media is still nothing to show; an export is.
        await change(id, { scenes: { create: [{ id: crypto.randomUUID(), caption: "Words only" }] } });
        expect((await call("POST", `/v1/projects/${id}/shares`, {})).status).toBe(409);
        const exported = await change(id, { project: { final_video_url: file("export.mp4") } });
        expect(exported.status).toBe(200);
        expect(exported.body.project.final_video_url).toBe(file("export.mp4"));
        expect((await call("POST", `/v1/projects/${id}/shares`, {})).status).toBe(201);
    });

    it("final_video_url takes only our storage and can be cleared", async () => {
        const id = await project();
        const elsewhere = await change(id, { project: { final_video_url: "https://example.com/v.mp4" } });
        expect(elsewhere.status).toBe(400);
        expect((await change(id, { project: { final_video_url: file("v.mp4") } })).status).toBe(200);
        expect((await call("GET", `/v1/projects/${id}`)).body.final_video_url).toBe(file("v.mp4"));
        expect((await change(id, { project: { final_video_url: null } })).status).toBe(200);
        expect((await call("GET", `/v1/projects/${id}`)).body.final_video_url).toBeNull();
    });

    it("caps active links per account (409 share_limit_reached) and creates per hour (429 with Retry-After)", async () => {
        await knob("share-limits", { max_active: 1, creates_per_hour: 3 });
        const a = await project("A");
        const b = await project("B");
        expect((await call("POST", `/v1/projects/${a}/shares`, {})).status).toBe(201);
        // Rotating the same project is not a new active link.
        expect((await call("POST", `/v1/projects/${a}/shares`, {})).status).toBe(201);
        const limited = await call("POST", `/v1/projects/${b}/shares`, {});
        expect(limited.status).toBe(409);
        expect(limited.body.error.code).toBe("share_limit_reached");
        // Only links made count against the hour: refusals (the cap, nothing to show) never use one.
        const empty = await project("Empty", false);
        expect((await call("POST", `/v1/projects/${empty}/shares`, {})).status).toBe(409);
        expect((await call("POST", `/v1/projects/${a}/shares`, {})).status).toBe(201);
        const busy = await call("POST", `/v1/projects/${a}/shares`, {});
        expect(busy.status).toBe(429);
        expect(busy.body.error.code).toBe("rate_limit_exceeded");
        expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("stops sharing (DELETE all: the links it revoked that were active) and revokes one by id (idempotent)", async () => {
        const id = await project();
        const link = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        const one = await call("DELETE", `/v1/projects/${id}/shares/${link.id}`);
        expect(one.status).toBe(200);
        expect(one.body).toMatchObject({ object: "project_share", id: link.id, status: "revoked" });
        expect(one.body.revoked_at).toMatch(/Z$/);
        expect((await call("DELETE", `/v1/projects/${id}/shares/${link.id}`)).body.revoked_at).toBe(one.body.revoked_at);
        expect((await call("DELETE", `/v1/projects/${id}/shares`)).body).toEqual({ object: "list", data: [] });
        const next = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        const stopped = (await call("DELETE", `/v1/projects/${id}/shares`)).body;
        expect(stopped.data.map((s: { id: string }) => s.id)).toEqual([next.id]);
        expect(stopped.data[0].status).toBe("revoked");
    });

    it("stop sharing changes active links only: an expired link stays expired (no revoked_at) and is not in the answer", async () => {
        const id = await project();
        const old = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        await knob("share-expire", { share_id: old.id });
        const live = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        const stopped = (await call("DELETE", `/v1/projects/${id}/shares`)).body;
        expect(stopped.data.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([[live.id, "revoked"]]);
        const listed = (await call("GET", `/v1/projects/${id}/shares`)).body.data;
        expect(listed.map((s: { id: string; status: string; revoked_at: string | null }) => [s.id, s.status, s.revoked_at === null])).toEqual([[live.id, "revoked", false], [old.id, "expired", true]]);
    });

    it("names share_base_url on every link and on GET /v1/account; the share-base-url knob plays an older server without it", async () => {
        const id = await project();
        expect((await call("GET", "/v1/account")).body.share_base_url).toBe(`${fake.url}/s`);
        expect((await knob("share-base-url", { value: null })).status).toBe(200);
        const older = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        expect("share_base_url" in older).toBe(false);
        expect(older.url).toBe(`${fake.url}/s/${older.token}`);
        expect("share_base_url" in (await call("GET", "/v1/account")).body).toBe(false);
        await knob("share-base-url", { value: "https://staging.opennan.com/s" });
        const staged = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        expect(staged).toMatchObject({ share_base_url: "https://staging.opennan.com/s", url: `https://staging.opennan.com/s/${staged.token}` });
        expect((await knob("share-base-url", { value: 3 })).status).toBe(400);
        fake.reset();
        key = fake.mintKey();
        expect((await call("GET", "/v1/account")).body.share_base_url).toBe(`${fake.url}/s`);
    });

    it("answers 404 for another project's link, a malformed id, and a trashed or unknown project", async () => {
        const a = await project("A");
        const b = await project("B");
        const link = (await call("POST", `/v1/projects/${a}/shares`, {})).body;
        expect((await call("DELETE", `/v1/projects/${b}/shares/${link.id}`)).status).toBe(404);
        expect((await call("DELETE", `/v1/projects/${a}/shares/shr_nope`)).status).toBe(400);
        await call("DELETE", `/v1/projects/${b}`);
        expect((await call("POST", `/v1/projects/${b}/shares`, {})).status).toBe(404);
        expect((await call("GET", "/v1/projects/nope/shares")).status).toBe(404);
    });

    it("lists at most 20 links, newest first", async () => {
        await knob("share-limits", { creates_per_hour: 100 });
        const id = await project();
        for (let i = 0; i < 22; i++) await call("POST", `/v1/projects/${id}/shares`, {});
        const list = (await call("GET", `/v1/projects/${id}/shares`)).body.data;
        expect(list).toHaveLength(20);
        expect(list[0].status).toBe("active");
        expect(list.slice(1).every((s: { status: string }) => s.status === "revoked")).toBe(true);
    });
});

describe("share links: the public view", () => {
    it("shows the export to anyone holding the link, counts the view and sends the privacy headers", async () => {
        const id = await project("Trip to the sea");
        await change(id, { project: { final_video_url: file("export.mp4") } });
        const link = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        const view = await call("GET", `/v1/shares/${link.token}`, undefined, {}, false);
        expect(view.status).toBe(200);
        expect(view.headers.get("cache-control")).toBe("no-store");
        expect(view.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect(view.headers.get("referrer-policy")).toBe("no-referrer");
        expect(view.body).toMatchObject({ object: "shared_project", title: "Trip to the sea", owner_name: "Ada Lovelace", aspect_ratio: "16:9", allow_download: false, scenes: [] });
        expect(view.body.video.url).toMatch(new RegExp(`^${file("export.mp4").replace(/[.?]/g, "\\$&")}\\?`));
        expect(view.body.video.download_url).toBeUndefined();
        // No ids, emails or prompts in the public answer.
        expect(JSON.stringify(view.body)).not.toMatch(/shr_|ada@example\.com|project_id|"id"/);
        const listed = (await call("GET", `/v1/projects/${id}/shares`)).body.data[0];
        expect(listed.views).toBe(1);
        expect(listed.last_viewed_at).toMatch(/Z$/);
    });

    it("previews the scenes in order without an export, and offers a download only when allowed", async () => {
        const id = await project();
        const link = (await call("POST", `/v1/projects/${id}/shares`, { allow_download: true })).body;
        const view = (await call("GET", `/v1/shares/${link.token}`, undefined, {}, false)).body;
        expect(view.video).toBeNull();
        expect(view.scenes).toHaveLength(1);
        expect(view.scenes[0]).toMatchObject({ duration: 5, video_url: null });
        expect(view.scenes[0].image_url).toContain("/files/results/a.png?");
        await change(id, { project: { final_video_url: file("export.mp4") } });
        const exported = (await call("GET", `/v1/shares/${link.token}`, undefined, {}, false)).body;
        expect(exported.video.download_url).toContain("/files/results/export.mp4?");
    });

    it("answers 404 share_not_found, 410 share_revoked / share_expired / share_unavailable, re-checked every view", async () => {
        expect((await call("GET", "/v1/shares/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL", undefined, {}, false)).body.error.code).toBe("share_not_found");
        const id = await project();
        const link = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        await knob("share-expire", { share_id: link.id });
        const expired = await call("GET", `/v1/shares/${link.token}`, undefined, {}, false);
        expect([expired.status, expired.body.error.code]).toEqual([410, "share_expired"]);
        expect((await call("GET", `/v1/projects/${id}/shares`)).body.data[0].status).toBe("expired");
        const fresh = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        await call("DELETE", `/v1/projects/${id}`);
        expect((await call("GET", `/v1/shares/${fresh.token}`, undefined, {}, false)).body.error.code).toBe("share_unavailable");
    });

    it("takes a report on any known link (202) and refuses unknown reasons", async () => {
        const id = await project();
        const link = (await call("POST", `/v1/projects/${id}/shares`, {})).body;
        expect((await call("POST", `/v1/shares/${link.token}/reports`, { reason: "spam" }, {}, false)).status).toBe(202);
        expect((await call("POST", `/v1/shares/${link.token}/reports`, { reason: "boring" }, {}, false)).status).toBe(400);
    });

    it("lists the links in the test state and forgets them on reset", async () => {
        const id = await project();
        await call("POST", `/v1/projects/${id}/shares`, {});
        expect(fake.cloud.state().shares).toHaveLength(1);
        fake.reset();
        expect(fake.cloud.state().shares).toHaveLength(0);
    });
});

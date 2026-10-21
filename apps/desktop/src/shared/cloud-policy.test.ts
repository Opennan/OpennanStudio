import { checkCloudRequest, checkCloudStream, cloudStorageUrlRule, isAllowedCloudPath, isCloudStoreKey, isStreamablePath } from "./cloud-policy";

describe("cloud request allowlist", () => {
    it.each([
        "/v1/projects", "/v1/projects/import", "/v1/projects/abc_DEF-123", `/v1/projects/${"a".repeat(36)}`,
        "/v1/projects/p1/document", "/v1/projects/p1/changes", "/v1/projects/p1/restore", "/v1/storage",
    ])("allows %s", (path) => {
        expect(isAllowedCloudPath(path)).toBe(true);
    });

    it.each([
        "/v1/account", "/v1/uploads", "/v1/uploads/x/complete", "/v1/auth/key", "/v1/projects/", "/v1/projects/../account", "/v1/projects/a/b",
        "/v1/projects/a.b", `/v1/projects/${"a".repeat(37)}`, "/v1/projects/p1/timeline/undo", "/v1/projects/p1/document/", "/v1/projects?x=1",
        "/v1/projects#x", "v1/projects", "https://evil.example/v1/projects", "//evil.example/v1/projects", "/v1/projects/p1%2Fdocument", "/v1/storage\n",
    ])("refuses %s", (path) => {
        expect(isAllowedCloudPath(path)).toBe(false);
    });

    it("allows the sync engine's methods, headers, queries and bodies", () => {
        expect(checkCloudRequest("POST", "/v1/projects/p1/changes", { body: { label: "x" }, headers: { "Idempotency-Key": "k", "If-Match": "\"r3\"" } })).toBeNull();
        expect(checkCloudRequest("GET", "/v1/projects/p1/document", { headers: { "if-none-match": "\"r3\"" } })).toBeNull();
        expect(checkCloudRequest("GET", "/v1/projects", { query: { order: "updated", state: "deleted", limit: 50 } })).toBeNull();
        expect(checkCloudRequest("DELETE", "/v1/projects/p1", { query: { permanent: true } })).toBeNull();
        expect(checkCloudRequest("PATCH", "/v1/projects/p1", { body: { name: "n" } })).toBeNull();
    });

    it.each([
        ["PUT", "/v1/projects", {}],
        ["HEAD", "/v1/projects", {}],
        ["get", "/v1/projects", {}],
        ["GET", "/v1/account", {}],
        ["GET", "/v1/projects", { headers: { Authorization: "Bearer x" } }],
        ["GET", "/v1/projects", { headers: { Cookie: "a=b" } }],
        ["GET", "/v1/projects", { headers: { "X-Forwarded-For": "1.2.3.4" } }],
        ["GET", "/v1/projects", { headers: { "If-Match": "x".repeat(201) } }],
        ["GET", "/v1/projects", { headers: { "Idempotency-Key": "a\r\nAuthorization: x" } }],
        ["GET", "/v1/projects", { headers: { "If-Match": 3 } }],
        ["GET", "/v1/projects", { query: { cursor: { $gt: 1 } } }],
        ["GET", "/v1/projects", { query: { cursor: ["a"] } }],
        ["GET", "/v1/projects", { query: { "bad key": "x" } }],
        ["GET", "/v1/projects", { query: { limit: Number.NaN } }],
        ["POST", "/v1/projects", { body: { blob: "x".repeat(2.5 * 1024 * 1024) } }],
    ])("refuses %s %s %j", (method, path, request) => {
        expect(checkCloudRequest(method, path, request as never)).toEqual(expect.any(String));
    });
});

describe("AI director routes (phase 9b)", () => {
    const TURN = `turn_${"0a".repeat(12)}`;
    const SCENE = `s_${"b".repeat(62)}`;
    it.each([
        ["GET", "/v1/projects/p1/director/turns"],
        ["POST", "/v1/projects/p1/director/turns"],
        ["GET", `/v1/projects/p1/director/turns/${TURN}`],
        ["POST", `/v1/projects/p1/director/turns/${TURN}/cancel`],
        ["POST", "/v1/quotes"],
        ["POST", "/v1/projects/p1/story/plan"],
        ["POST", "/v1/projects/p1/scenes/scene-1/storyboard"],
        ["POST", `/v1/projects/p1/scenes/${SCENE}/videos`],
        ["POST", "/v1/projects/p1/scenes/s1/copy-video/detections"],
        ["POST", "/v1/projects/p1/scenes/s1/shots/0/image-edits"],
        ["POST", "/v1/projects/p1/scenes/s1/shots/999/image-edits"],
        ["POST", "/v1/projects/p1/scenes/s1/copy-video/recreate"],
        ["GET", "/v1/tasks/task_123-abc"],
        ["POST", "/v1/tasks/task_123-abc/cancel"],
        ["GET", "/v1/projects/p1/script"],
        ["PATCH", "/v1/projects/p1"],
        ["POST", "/v1/projects/p1/changes"],
        ["GET", "/v1/projects/p1/changes"],
        // agents' no-charge copy-video edits (MCP, phase 9b)
        ["PUT", "/v1/projects/p1/scenes/s1/copy-video/source"],
        ["PATCH", "/v1/projects/p1/scenes/s1/shots/0"],
        ["PATCH", "/v1/projects/p1/scenes/s1/shots/999"],
    ])("allows %s %s", (method, path) => {
        expect(checkCloudRequest(method, path, {})).toBeNull();
    });

    it("sends the director's query, header and body shapes", () => {
        expect(checkCloudRequest("GET", "/v1/projects/p1/director/turns", { query: { limit: 20, cursor: TURN } })).toBeNull();
        expect(checkCloudRequest("GET", "/v1/tasks/t1", { query: { wait: 50 } })).toBeNull();
        expect(checkCloudRequest("GET", "/v1/tasks/t1", { query: { wait: 0 } })).toBeNull();
        expect(checkCloudRequest("POST", "/v1/projects/p1/story/plan", { body: { style: "noir" }, headers: { "Idempotency-Key": "k-1" } })).toBeNull();
        expect(checkCloudRequest("POST", "/v1/quotes", { body: { tool: "storyboard", project_id: "p1", scene_id: "s1" } })).toBeNull();
        expect(checkCloudRequest("PATCH", "/v1/projects/p1", { body: { script_text: "Hi.", srt_content: null }, headers: { "If-Match": "\"r3\"" } })).toBeNull();
    });

    it.each([
        // methods a route does not take
        ["DELETE", "/v1/tasks/t1"], ["PATCH", "/v1/tasks/t1"], ["POST", "/v1/tasks/t1"], ["GET", "/v1/tasks/t1/cancel"],
        ["GET", "/v1/quotes"], ["DELETE", "/v1/projects/p1/director/turns"], ["PATCH", `/v1/projects/p1/director/turns/${TURN}`],
        ["POST", `/v1/projects/p1/director/turns/${TURN}`], ["GET", `/v1/projects/p1/director/turns/${TURN}/cancel`],
        ["GET", "/v1/projects/p1/story/plan"], ["DELETE", "/v1/projects/p1/scenes/s1/storyboard"], ["POST", "/v1/projects/p1/script"],
        ["PATCH", "/v1/projects/p1/script"],
        // ids of other shapes
        ["GET", "/v1/projects/p1/director/turns/turn_123"], ["GET", `/v1/projects/p1/director/turns/turn_${"A".repeat(24)}`],
        ["GET", `/v1/projects/p1/director/turns/${TURN}0`], ["POST", `/v1/projects/${"a".repeat(37)}/director/turns`],
        ["POST", "/v1/projects/p.1/director/turns"], ["POST", `/v1/projects/p1/scenes/${"s".repeat(65)}/storyboard`],
        ["POST", "/v1/projects/p1/scenes/s.1/storyboard"], ["POST", "/v1/projects/p1/scenes/s1/shots/1000/image-edits"],
        ["POST", "/v1/projects/p1/scenes/s1/shots/-1/image-edits"], ["POST", "/v1/projects/p1/scenes/s1/shots/x/image-edits"],
        ["GET", `/v1/tasks/${"t".repeat(65)}`], ["GET", "/v1/tasks/"], ["GET", "/v1/tasks/a.b"],
        // traversal, query strings and fragments in the path, encoded slashes
        ["GET", "/v1/projects/p1/director/turns/../../document"], ["GET", "/v1/tasks/../account"], ["GET", "/v1/tasks/t1?wait=50"],
        ["POST", "/v1/projects/p1/director/turns?stream=true"], ["POST", "/v1/quotes#x"], ["POST", "/v1/projects/p1/scenes/s1%2Fx/storyboard"],
        ["POST", "/v1/quotes/"], ["POST", "/v1/projects/p1/story/plan/"],
        // routes Studio's director never calls
        ["GET", "/v1/projects/p1/exports"], ["POST", "/v1/projects/p1/exports"], ["GET", "/v1/tasks"], ["POST", "/v1/projects/p1/story"],
        ["POST", "/v1/projects/p1/scenes/s1/images"], ["GET", "/v1/projects/p1/scenes"], ["POST", "/v1/projects/p1/director"],
        ["GET", "/v1/tools"], ["GET", "/v1/account"], ["POST", "/v1/projects/p1/scenes/s1/copy-video/source"],
        // PUT only for the copy-video source; a shot only takes PATCH
        ["PUT", "/v1/projects/p1"], ["PUT", "/v1/projects/p1/document"], ["PUT", "/v1/projects/p1/scenes/s1/storyboard"], ["GET", "/v1/projects/p1/scenes/s1/copy-video/source"],
        ["DELETE", "/v1/projects/p1/scenes/s1/copy-video/source"], ["GET", "/v1/projects/p1/scenes/s1/shots/0"], ["PUT", "/v1/projects/p1/scenes/s1/shots/0"],
        ["DELETE", "/v1/projects/p1/scenes/s1/shots/0"], ["PATCH", "/v1/projects/p1/scenes/s1/shots/1000"],
    ])("refuses %s %s", (method, path) => {
        expect(checkCloudRequest(method, path, {})).toEqual(expect.any(String));
    });

    it("keeps query values bounded", () => {
        for (const wait of [51, -1, 1.5, "50", Number.POSITIVE_INFINITY]) expect(checkCloudRequest("GET", "/v1/tasks/t1", { query: { wait } })).toEqual(expect.any(String));
        for (const limit of [0, 201, 2.5, "20"]) expect(checkCloudRequest("GET", "/v1/projects/p1/director/turns", { query: { limit } })).toEqual(expect.any(String));
        expect(checkCloudRequest("GET", "/v1/projects/p1/director/turns", { query: { cursor: "x".repeat(513) } })).toEqual(expect.any(String));
    });

    it("streams only a director turn POST", () => {
        expect(isStreamablePath("/v1/projects/p1/director/turns")).toBe(true);
        for (const path of [`/v1/projects/p1/director/turns/${TURN}`, "/v1/projects/p1/changes", "/v1/quotes", "/v1/tasks/t1", "/v1/projects/p1/director/turns?x=1", "/v1/projects/../director/turns"]) {
            expect(isStreamablePath(path)).toBe(false);
        }
        expect(checkCloudStream("POST", "/v1/projects/p1/director/turns", { body: { message: "Hi", stream: true }, headers: { "Idempotency-Key": "k" } })).toBeNull();
        expect(checkCloudStream("GET", "/v1/projects/p1/director/turns", {})).toEqual(expect.any(String));
        expect(checkCloudStream("POST", "/v1/projects/p1/changes", {})).toEqual(expect.any(String));
        expect(checkCloudStream("POST", "/v1/projects/p1/director/turns", { headers: { Authorization: "Bearer x" } })).toEqual(expect.any(String));
        expect(checkCloudStream("POST", "/v1/projects/p1/director/turns", { body: { message: "x".repeat(2.5 * 1024 * 1024) } })).toEqual(expect.any(String));
        expect(checkCloudStream("POST", "/v1/projects/p1/director/turns", { query: { stream: true } } as never)).toEqual(expect.any(String));
    });
});

describe("cloud storage URLs", () => {
    it("takes OpenNan's CDN only, never a temporary upload", () => {
        const rule = cloudStorageUrlRule(null);
        expect(rule("https://cdn.opennan.com/uploads/media/o/abc.mp4")).toBe(true);
        expect(rule("https://cdn.opennan.com/projects/p/uploads/t.png")).toBe(true);
        for (const url of [
            "https://cdn.opennan.com/uploads/temp/o/t.wav", "https://cdn.opennan.com/uploads%2Ftemp/o/t.wav", "http://cdn.opennan.com/a.mp4",
            "https://cdn.opennan.com.evil.example/a.mp4", "https://user:pw@cdn.opennan.com/a.mp4", "https://evil.example/https://cdn.opennan.com/a.mp4",
            "http://127.0.0.1:4318/files/uploads/media/o/a.mp4", "opennan-local://media/x", "not a url",
        ]) expect(rule(url)).toBe(false);
    });

    it("takes the fake server's files only when the API base is loopback", () => {
        const fake = cloudStorageUrlRule("http://127.0.0.1:4318");
        expect(fake("http://127.0.0.1:4318/files/uploads/media/o/a.mp4")).toBe(true);
        expect(fake("https://cdn.opennan.com/a.mp4")).toBe(true);
        expect(fake("http://127.0.0.1:4318/files/uploads/temp/o/a.wav")).toBe(false);
        expect(fake("http://127.0.0.1:4318/v1/account")).toBe(false);
        expect(fake("http://127.0.0.1:9999/files/a.mp4")).toBe(false);
        expect(cloudStorageUrlRule("https://api.opennan.com")("https://api.opennan.com/files/a.mp4")).toBe(false);
        const anyLoopback = cloudStorageUrlRule("loopback");
        expect(anyLoopback("http://127.0.0.1:5555/files/a.mp4")).toBe(true);
        expect(anyLoopback("http://localhost:5555/files/a.mp4")).toBe(true);
        expect(anyLoopback("http://10.0.0.1:5555/files/a.mp4")).toBe(false);
        expect(anyLoopback("http://127.0.0.1:5555/files/uploads/temp/a.wav")).toBe(false);
    });
});

describe("cloud store keys", () => {
    it("are short ids with no path characters", () => {
        for (const key of ["cloud-abc", "u-0123abcd-17", "a:b", "A_b-1", "x".repeat(120)]) expect(isCloudStoreKey(key)).toBe(true);
        for (const key of ["", "../x", "a/b", "a\\b", "a.b", ".", "x".repeat(121), "a b", "a\0b"]) expect(isCloudStoreKey(key)).toBe(false);
    });
});

describe("share links and proposal runs (phase 9c)", () => {
    const SHARE = `shr_${"0a".repeat(12)}`;
    const TURN = `turn_${"0a".repeat(12)}`;
    const PROP = `prop_${"1b".repeat(12)}`;
    it.each([
        ["POST", "/v1/projects/p1/shares"],
        ["GET", "/v1/projects/p1/shares"],
        ["DELETE", "/v1/projects/p1/shares"],
        ["DELETE", `/v1/projects/p1/shares/${SHARE}`],
        ["POST", `/v1/projects/p1/director/turns/${TURN}/proposals/${PROP}/run`],
    ])("allows %s %s", (method, path) => {
        expect(checkCloudRequest(method, path, {})).toBeNull();
    });

    it.each([
        ["PATCH", "/v1/projects/p1/shares"], ["PUT", "/v1/projects/p1/shares"], ["GET", `/v1/projects/p1/shares/${SHARE}`], ["POST", `/v1/projects/p1/shares/${SHARE}`],
        ["DELETE", "/v1/projects/p1/shares/shr_123"], ["DELETE", `/v1/projects/p1/shares/${SHARE}0`], ["DELETE", `/v1/projects/p1/shares/${SHARE.toUpperCase()}`],
        ["DELETE", "/v1/projects/p1/shares/../document"], ["GET", "/v1/projects/p1/shares?x=1"],
        // the public share routes are the page's, never Studio's
        ["GET", "/v1/shares/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL"], ["POST", "/v1/shares/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL/reports"],
        ["GET", `/v1/projects/p1/director/turns/${TURN}/proposals/${PROP}/run`], ["POST", `/v1/projects/p1/director/turns/${TURN}/proposals/${PROP}`],
        ["POST", `/v1/projects/p1/director/turns/${TURN}/proposals/prop_123/run`], ["POST", `/v1/projects/p1/director/turns/turn_1/proposals/${PROP}/run`],
    ])("refuses %s %s", (method, path) => {
        expect(checkCloudRequest(method, path, {})).toEqual(expect.any(String));
    });
});

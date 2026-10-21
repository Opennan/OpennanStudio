import Database from "better-sqlite3";

describe("desktop test runtime", () => {
    it("runs inside Electron's Node", () => {
        expect(process.versions.electron).toMatch(/^44\./);
    });

    it("loads better-sqlite3 built for this runtime", () => {
        const db = new Database(":memory:");
        expect(db.prepare("select sqlite_version() as v").get()).toMatchObject({ v: expect.stringMatching(/^3\./) });
        db.close();
    });

    it("loads node-pty", async () => {
        const pty = await import("node-pty");
        expect(typeof pty.spawn).toBe("function");
    });
});

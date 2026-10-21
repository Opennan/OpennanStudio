import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectFileError, lockProjectFile, parseProjectFile, readProjectFile, serializeProjectFile, writeProjectFile } from "./project-file";
import { fixtureProject } from "./testing/fixture";

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-project-file-"));
    file = path.join(dir, "fixture.opennan.json");
    await writeProjectFile(file, fixtureProject());
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("project files", () => {
    it("round-trips a project", async () => {
        expect((await readProjectFile(file)).project.scenes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
        expect(parseProjectFile(serializeProjectFile(fixtureProject())).project.meta.id).toBe("fixture");
    });

    it("rejects files that are not projects", () => {
        expect(() => parseProjectFile("{")).toThrow(ProjectFileError);
        expect(() => parseProjectFile(JSON.stringify({ format: "x" }))).toThrow(/is not an OpenNan Studio project/);
        expect(() => parseProjectFile(JSON.stringify({ format: "opennan-studio-project", version: 2 }))).toThrow(/unsupported version 2/);
        expect(() => parseProjectFile(JSON.stringify({ format: "opennan-studio-project", version: 1, project: { meta: { id: "p" }, tracks: [], clips: {} } })))
            .toThrow(/project.clips must be an array/);
    });
});

describe("lockProjectFile", () => {
    it("refuses a second writer until the first releases its lock", async () => {
        const first = await lockProjectFile(file);
        await expect(lockProjectFile(file)).rejects.toThrow(/is already open for writing \(pid \d+\)/);
        await first.release();
        const again = await lockProjectFile(file);
        await again.release();
    });

    it("lets only one of several concurrent openers take over a stale lock", async () => {
        // Repeated: the race (an opener reading the winner's lock before its contents are written) is timing dependent.
        for (let round = 0; round < 15; round += 1) {
            await writeFile(`${file}.lock`, JSON.stringify({ pid: 2147483646, startedAt: "2026-01-01T00:00:00.000Z" }));
            const results = await Promise.allSettled([lockProjectFile(file), lockProjectFile(file), lockProjectFile(file), lockProjectFile(file)]);
            expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
            // The winner's lock file is still there for other processes to see.
            expect(JSON.parse(await readFile(`${file}.lock`, "utf8")).pid).toBe(process.pid);
            for (const r of results) if (r.status === "fulfilled") await r.value.release();
        }
    });

    it("waits for a fresh lock that is still being written instead of taking it over", async () => {
        await writeFile(`${file}.lock`, "");
        const started = Date.now();
        const lock = await lockProjectFile(file);
        // An empty lock is taken over only after the short settling wait.
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
        await lock.release();
    });

    it("takes over a stale lock and removes it on release", async () => {
        // No process has this pid (above every OS pid limit), so the lock is stale.
        await writeFile(`${file}.lock`, JSON.stringify({ pid: 2147483646, startedAt: "2026-01-01T00:00:00.000Z" }));
        const lock = await lockProjectFile(file);
        expect(JSON.parse(await readFile(`${file}.lock`, "utf8")).pid).toBe(process.pid);
        await lock.release();
        await expect(readFile(`${file}.lock`, "utf8")).rejects.toThrow(/ENOENT/);
    });
});

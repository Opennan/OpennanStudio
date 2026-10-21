import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalFileReader, isRemotePath } from "./local-files";

let dir: string;
let project: string;
let outside: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-files-"));
    project = path.join(dir, "project");
    outside = path.join(dir, "outside");
    await mkdir(project);
    await mkdir(outside);
    await writeFile(path.join(project, "a.wav"), new Uint8Array([1, 2, 3]));
    await writeFile(path.join(project, "notes.txt"), "x");
    await writeFile(path.join(outside, "secret.wav"), new Uint8Array([9]));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("createLocalFileReader", () => {
    it("reads audio and video files inside the project folder", async () => {
        const read = await createLocalFileReader({ baseDir: project });
        const file = await read("a.wav", "audio");
        expect(file).toMatchObject({ name: "a.wav", type: "audio/wav", size: 3 });
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        await expect(read("a.wav", "video")).rejects.toThrow("a.wav is not a video file");
        await expect(read("notes.txt", "audio")).rejects.toThrow("notes.txt is not an audio file");
    });

    it("refuses absolute paths, .. paths, and symlinks that leave the allowed folders", async () => {
        const read = await createLocalFileReader({ baseDir: project });
        await expect(read(path.join(outside, "secret.wav"), "audio")).rejects.toThrow(/is outside the project folder/);
        await expect(read("../outside/secret.wav", "audio")).rejects.toThrow(/is outside the project folder/);
        await symlink(path.join(outside, "secret.wav"), path.join(project, "link.wav"));
        await expect(read("link.wav", "audio")).rejects.toThrow(/is outside the project folder/);
        await symlink(path.join(project, "notes.txt"), path.join(project, "notes.wav"));
        await expect(read("notes.wav", "audio")).rejects.toThrow("notes.wav is not an audio file");
    });

    it("never touches network or device paths (realpath of a UNC path already reaches the share)", async () => {
        const read = await createLocalFileReader({ baseDir: project });
        for (const remote of ["\\\\attacker.example\\s\\a.wav", "//attacker.example/s/a.wav", "\\\\?\\UNC\\host\\a.wav", "\\\\.\\pipe\\x.wav"]) {
            expect(isRemotePath(remote)).toBe(true);
            await expect(read(remote, "audio")).rejects.toThrow("Network paths are not read");
        }
        expect(isRemotePath("/Users/me/a.wav")).toBe(false);
        expect(isRemotePath("C:\\Users\\a.wav")).toBe(false);
        // Outside the folders as written: refused before any filesystem call (an automount path on macOS).
        await expect(read("/net/attacker.example/a.wav", "audio")).rejects.toThrow(/is outside the project folder/);
    });

    it("allows --allow-dir folders and rejects missing ones up front", async () => {
        const read = await createLocalFileReader({ baseDir: project, allowDirs: [outside] });
        await expect(read(path.join(outside, "secret.wav"), "audio")).resolves.toMatchObject({ size: 1 });
        await expect(createLocalFileReader({ baseDir: project, allowDirs: [path.join(dir, "missing")] })).rejects.toThrow(/--allow-dir folder not found/);
    });
});

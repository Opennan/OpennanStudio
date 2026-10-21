import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSourcePolicy, jobFilePath, LOCAL_PROTOCOLS } from "./source-policy";

describe("createSourcePolicy (fail closed)", () => {
    let root: string;
    let media: string;
    beforeAll(() => {
        root = mkdtempSync(path.join(tmpdir(), "opennan-policy-"));
        mkdirSync(path.join(root, "media"));
        media = path.join(root, "media", "clip.webm");
        writeFileSync(media, "x");
        symlinkSync("/etc", path.join(root, "media", "etc-link"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const policy = () => createSourcePolicy({ mediaRoots: [path.join(root, "media")] });

    it("opens files under a media root, by file:// URL or absolute path", async () => {
        expect(await policy().resolve(pathToFileURL(media).href)).toMatch(/clip\.webm$/);
        expect(await policy().resolve(media)).toMatch(/clip\.webm$/);
    });

    it("rejects local files outside the roots, also through symlinks and ..", async () => {
        expect(await policy().resolve("/etc/passwd")).toBeNull();
        expect(await policy().resolve("file:///etc/passwd")).toBeNull();
        expect(await policy().resolve(path.join(root, "media", "etc-link", "passwd"))).toBeNull();
        expect(await policy().resolve(`${path.join(root, "media")}/../../../../etc/passwd`)).toBeNull();
    });

    it("rejects network and ffmpeg protocol sources unless the host opts in", async () => {
        expect(await policy().resolve("http://169.254.169.254/latest/meta-data/")).toBeNull();
        expect(await policy().resolve(`concat:${media}|${media}`)).toBeNull();
        expect(await policy().resolve(`subfile,,start,0,end,1,,:${media}`)).toBeNull();
        expect(await policy().resolve("data:video/mp4;base64,AAAA")).toBeNull();
        expect(await policy().resolve("relative/clip.webm")).toBeNull();
        const network = createSourcePolicy({ mediaRoots: [], allowNetworkMedia: true });
        expect(await network.resolve("https://cdn.example/clip.mp4")).toBe("https://cdn.example/clip.mp4");
        expect(network.inputGuards[1]).toContain("https");
    });

    it("maps host schemes through resolveSource and still checks the roots", async () => {
        const hosted = createSourcePolicy({
            mediaRoots: [path.join(root, "media")],
            resolveSource: (url) => (url.startsWith("opennan-local://") ? path.join(root, "media", url.slice("opennan-local://".length)) : null),
        });
        expect(await hosted.resolve("opennan-local://clip.webm")).toMatch(/clip\.webm$/);
        expect(await hosted.resolve("opennan-local://../../../../etc/passwd")).toBeNull();
        expect(await hosted.resolve(media)).toBeNull();
    });

    it("guards every input with local protocols and plain media demuxers", () => {
        const [protocolFlag, protocols, formatFlag, formats] = policy().inputGuards;
        expect([protocolFlag, protocols, formatFlag]).toEqual(["-protocol_whitelist", LOCAL_PROTOCOLS, "-format_whitelist"]);
        expect(formats).not.toMatch(/hls|concat|lavfi|avfoundation/);
    });
});

describe("jobFilePath", () => {
    it("keeps job files inside the job directory", () => {
        expect(jobFilePath("/tmp/job", "raster-0.png")).toBe(path.resolve("/tmp/job/raster-0.png"));
        for (const name of ["../evil.png", "a/b.png", "..", "/etc/passwd", "x\\..\\y", "../../../../Users/x/Library/LaunchAgents/evil.png"]) {
            expect(() => jobFilePath("/tmp/job", name), name).toThrow();
        }
    });
    it("accepts one %05d frame pattern (image-sequence inputs) and nothing else of ffmpeg's syntax", () => {
        expect(jobFilePath("/tmp/job", "gfx0-%05d.png")).toBe(path.resolve("/tmp/job/gfx0-%05d.png"));
        for (const name of ["gfx-%d.png", "gfx-%05d-%05d.png", "%s.png", "gfx-%05d/../x.png", "*.png", "gfx-%05d.png?x"]) {
            expect(() => jobFilePath("/tmp/job", name), name).toThrow();
        }
    });
});

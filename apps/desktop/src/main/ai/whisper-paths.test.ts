import path from "node:path";
import { resolveWhisper } from "./whisper-paths";

const base = { env: {}, resourcesPath: "/app/Resources", appPath: "/src/apps/desktop", platform: "darwin" as const, arch: "arm64" };
const has = (...files: string[]) => (file: string) => files.includes(file);

describe("resolveWhisper", () => {
    it("uses only the bundled folder in packaged builds", () => {
        const dir = path.join("/app/Resources", "whisper");
        expect(resolveWhisper({ ...base, isPackaged: true, env: { OPENNAN_WHISPER_DIR: "/elsewhere" }, exists: has(path.join(dir, "whisper-cli"), path.join(dir, "checksums.json")) }))
            .toEqual({ dir, reason: null });
    });

    it("uses the fetched folder or an absolute override when unpackaged", () => {
        const fetched = path.join("/src/apps/desktop", "resources", "whisper", "darwin-arm64");
        expect(resolveWhisper({ ...base, isPackaged: false, exists: has(path.join(fetched, "whisper-cli"), path.join(fetched, "checksums.json")) }).dir).toBe(fetched);
        expect(resolveWhisper({ ...base, isPackaged: false, env: { OPENNAN_WHISPER_DIR: "/w" }, exists: has(path.join("/w", "whisper-cli"), path.join("/w", "checksums.json")) }).dir).toBe("/w");
        expect(resolveWhisper({ ...base, isPackaged: false, env: { OPENNAN_WHISPER_DIR: "relative" }, exists: has(path.join(fetched, "whisper-cli"), path.join(fetched, "checksums.json")) }).dir).toBe(fetched);
    });

    it("needs both the binary and checksums.json, and says why it is missing", () => {
        const dir = path.join("/app/Resources", "whisper");
        const missing = resolveWhisper({ ...base, platform: "win32", arch: "arm64", isPackaged: true, exists: has(path.join(dir, "whisper-cli.exe")) });
        expect(missing).toEqual({ dir: null, reason: "This build has no whisper.cpp for win32-arm64, so auto captions are not available." });
    });
});

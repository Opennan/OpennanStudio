import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopPaths, ensureDirs, projectDir } from "./paths";
import { isUuid } from "../shared/ids";

describe("desktopPaths", () => {
    it("derives every folder from userData and videos", () => {
        const p = desktopPaths({ userData: "/u", videos: "/v", env: {} });
        expect(p).toEqual({
            userData: "/u", database: path.join("/u", "opennan-studio.sqlite"), media: path.join("/u", "media"),
            projects: path.join("/u", "projects"), mcp: path.join("/u", "mcp"), tokenFile: path.join("/u", "mcp", "token"), models: path.join("/u", "models", "whisper"), cloud: path.join("/u", "cloud"),
            exports: path.join("/v", "OpenNan Studio"),
        });
    });

    it("honours absolute test overrides only", () => {
        const p = desktopPaths({ userData: "/u", videos: "/v", env: { OPENNAN_STUDIO_USER_DATA: path.resolve("/t"), OPENNAN_STUDIO_EXPORTS_DIR: path.resolve("/e") } });
        expect(p.userData).toBe(path.resolve("/t"));
        expect(p.exports).toBe(path.resolve("/e"));
        expect(desktopPaths({ userData: "/u", videos: "/v", env: { OPENNAN_STUDIO_USER_DATA: "relative" } }).userData).toBe("/u");
    });

    it("builds project folders from ids only", () => {
        const p = desktopPaths({ userData: "/u", videos: "/v", env: {} });
        const id = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
        expect(projectDir(p, id)).toBe(path.join("/u", "projects", id));
        expect(() => projectDir(p, "../etc")).toThrow("invalid project id");
        expect(() => projectDir(p, id.toUpperCase())).toThrow("invalid project id");
        expect(isUuid(id)).toBe(true);
        expect(isUuid(`${id}/..`)).toBe(false);
        // Cloud projects (phase 9a): "cloud-<server id>", whose ids are safe as file names.
        // Spelled case-safely (as the cloud store's file names): cloud-AbC and cloud-abc never share a folder.
        expect(projectDir(p, "cloud-AbC_1-2")).toBe(path.join("/u", "projects", "cloud-^ab^c_1-2"));
        expect(projectDir(p, "cloud-abc")).not.toBe(projectDir(p, "cloud-ABC"));
        for (const bad of ["cloud-", "cloud-../x", "cloud-a/b", `cloud-${"a".repeat(37)}`]) expect(() => projectDir(p, bad)).toThrow("invalid project id");
    });

    it("creates private folders", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-paths-"));
        const p = desktopPaths({ userData: path.join(root, "data"), videos: root, env: {} });
        ensureDirs(p);
        for (const dir of [p.media, p.projects, p.mcp]) expect(fs.statSync(dir).isDirectory()).toBe(true);
        if (process.platform !== "win32") expect(fs.statSync(p.mcp).mode & 0o777).toBe(0o700);
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// Sources read through Vite's raw glob (no Node types in the app's tsconfig).
const SOURCES = import.meta.glob("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function resolveImport(from: string, specifier: string): string | null {
    const parts = from.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
    }
    const base = parts.join("/");
    return [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find((file) => file in SOURCES) ?? null;
}

/** Files reachable from `entry` through relative value imports. */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const match of SOURCES[entry].matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
        const file = resolveImport(entry, match[1]);
        if (file) reachable(file, seen);
    }
    return seen;
}

describe("@opennan/web/studio", () => {
    it("never reaches the ffmpeg.wasm export or the IndexedDB runtime", () => {
        const files = [...reachable("./studio.ts")];
        expect(files).toContain("./editor/editor-screen.tsx");
        expect(files).not.toContain("./export/web-export.ts");
        expect(files).not.toContain("./platform/studio-runtime.ts");
        for (const file of files) expect(SOURCES[file]).not.toMatch(/@opennan\/export\/web|@ffmpeg\/|createIndexedDbPersistence/);
    });

    it("exports the shell", async () => {
        const studio = await import("./studio");
        expect(typeof studio.StudioApp).toBe("function");
        expect(typeof studio.exportInputFromSnapshot).toBe("function");
        expect(typeof studio.createStorageGuard).toBe("function");
        expect(typeof studio.createProjectHolds).toBe("function");
    }, 30_000); // imports the whole shell: slow when every package's tests run at once
});

// The @opennan/mcp/server entry must not reach Node-only modules through this
// package's sources: transports, headless mode, and the CLI live behind ".".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as serverApi from "./server-api";

const SRC = path.dirname(fileURLToPath(import.meta.url));
// @opennan/export/node spawns ffmpeg; only headless.ts (behind ".") may import it.
const NODE_ONLY = /^(node:|fs$|path$|http$|os$|net$|child_process$|stream$|@opennan\/export\/node$)/;

/** Relative import graph from an entry file: file -> its import specifiers. */
function importGraph(entry: string): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    const visit = (file: string) => {
        if (graph.has(file)) return;
        const specifiers = [...readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
        graph.set(file, specifiers);
        for (const specifier of specifiers.filter((s) => s.startsWith("."))) {
            const base = path.resolve(path.dirname(file), specifier);
            const resolved = [`${base}.ts`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
            if (resolved) visit(resolved);
        }
    };
    visit(entry);
    return graph;
}

describe("@opennan/mcp/server", () => {
    it("exports the server without any Node-only import", () => {
        expect(typeof serverApi.createStudioMcpServer).toBe("function");
        expect(typeof serverApi.createControllerSession).toBe("function");
        const graph = importGraph(path.join(SRC, "server-api.ts"));
        expect([...graph.keys()].map((file) => path.relative(SRC, file))).toEqual(expect.arrayContaining(["server.ts", "session.ts", "export.ts", "tool-calls.ts", path.join("handlers", "index.ts")]));
        const nodeImports = [...graph].flatMap(([file, specifiers]) => specifiers.filter((s) => NODE_ONLY.test(s)).map((s) => `${path.relative(SRC, file)} -> ${s}`));
        expect(nodeImports).toEqual([]);
    });
});

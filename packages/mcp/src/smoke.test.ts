import { readFileSync } from "node:fs";
import * as core from "@opennan/timeline-core";
import { STUDIO_TOOLS } from "@opennan/mcp-schema";
import { MCP_VERSION } from "./version";

describe("@opennan/mcp", () => {
    it("loads timeline-core and mcp-schema in node", () => {
        expect(typeof core.TimelineController).toBe("function");
        expect(STUDIO_TOOLS.length).toBeGreaterThan(100);
    });

    it("reports the package version", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
        expect(MCP_VERSION).toBe(pkg.version);
    });
});

import { readFileSync } from "node:fs";
import * as sdk from "@opennan/provider-sdk";
import * as schema from "./index";

describe("@opennan/mcp-schema public API", () => {
    it("reports the package version", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
        expect(schema.MCP_SCHEMA_VERSION).toBe(pkg.version);
    });

    it("exports the registry, coverage, and schema helpers", () => {
        expect(schema.STUDIO_TOOLS.length).toBe(schema.EDITOR_TOOLS.length + schema.CAPABILITY_TOOLS.length + schema.STUDIO_CAPABILITY_TOOLS.length + schema.PIPELINE_TOOLS.length + schema.STORY_FILM_TOOLS.length);
        expect(schema.OPENNAN_TOOL_NAMES).toHaveLength(130);
        expect(typeof schema.renderCoverageMarkdown).toBe("function");
        expect(typeof schema.editorCommandTypes).toBe("function");
        expect(schema.capabilityUnavailableMessage("qc_check", "opennan.qc")).toBe("Connect OpenNan to use qc_check.");
    });

    it("re-exports the provider SDK's capabilities (one source, spec §5.4)", () => {
        expect(schema.OPEN_CAPABILITIES).toBe(sdk.OPEN_CAPABILITIES);
        expect(schema.OPENNAN_CAPABILITIES).toBe(sdk.OPENNAN_CAPABILITIES);
        expect(schema.capabilityUnavailableMessage).toBe(sdk.capabilityUnavailableMessage);
    });
});

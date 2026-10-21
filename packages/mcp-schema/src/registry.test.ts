import { OPENNAN_TOOL_NAMES } from "./opennan-tool-names";
import { EDITOR_TOOLS, NOT_EXPOSED_TOOLS, STUDIO_TOOLS, getTool, toolCoverage } from "./registry";
import { ESTIMATE_TOOLS } from "./tools/capability";

describe("tool registry", () => {
    it("lists editor tools first, with unique snake_case names", () => {
        const names = STUDIO_TOOLS.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(names.slice(0, EDITOR_TOOLS.length)).toEqual(EDITOR_TOOLS.map((tool) => tool.name));
    });

    it("estimate_cost prices only tools the server lists", () => {
        for (const name of ESTIMATE_TOOLS) expect(getTool(name), name).toBeDefined();
    });

    it("finds tools by name", () => {
        expect(getTool("read_timeline")?.kind).toBe("read");
        expect(getTool("nope")).toBeUndefined();
    });
});

describe("input schemas agents accept", () => {
    const FORBIDDEN = ["$ref", "$defs", "definitions", "oneOf", "allOf", "not", "if", "then", "else", "patternProperties", "dependentSchemas", "unevaluatedProperties"];

    function lint(schema: Record<string, unknown>, at: string, problems: string[]): void {
        for (const key of FORBIDDEN) if (key in schema) problems.push(`${at}: ${key}`);
        const type = schema.type;
        if (Array.isArray(type) && !(type.length === 2 && type.includes("null"))) problems.push(`${at}: type union ${JSON.stringify(type)}`);
        const types = Array.isArray(type) ? type : [type];
        if (types.includes("array") && !schema.items) problems.push(`${at}: array without items`);
        for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) lint(child, `${at}.${key}`, problems);
        if (schema.items && typeof schema.items === "object") lint(schema.items as Record<string, unknown>, `${at}[]`, problems);
        for (const [i, branch] of ((schema.anyOf ?? []) as Record<string, unknown>[]).entries()) lint(branch, `${at}|${i}`, problems);
    }

    it("keeps every tool's input schema in the subset the three CLIs accept", () => {
        const problems: string[] = [];
        for (const tool of STUDIO_TOOLS) {
            if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) problems.push(`${tool.name}: root must be a closed object`);
            lint(tool.inputSchema as unknown as Record<string, unknown>, tool.name, problems);
        }
        expect(problems).toEqual([]);
    });
});

describe("OpenNan toolset coverage (spec §5.11)", () => {
    it("covers every OpenNan tool exactly once", () => {
        const covered = toolCoverage().filter((row) => (row.exposed ? row.tool.origin === "opennan" : true)).map((row) => row.name);
        expect([...covered].sort()).toEqual([...OPENNAN_TOOL_NAMES].sort());
    });

    it("marks studio additions as studio", () => {
        const opennan = new Set<string>(OPENNAN_TOOL_NAMES);
        for (const tool of STUDIO_TOOLS) expect(tool.origin === "opennan", tool.name).toBe(opennan.has(tool.name));
        expect(NOT_EXPOSED_TOOLS.every((tool) => opennan.has(tool.name))).toBe(true);
    });
});

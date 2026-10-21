import {
    commandSchema, editorCommandTypes, editorType, enumOf, int, objectOf, snakeProperties, str, toCamelCase, toSnakeCase,
} from "./json-schema";

describe("case conversion", () => {
    it("round-trips camelCase and snake_case", () => {
        expect(toSnakeCase("positionX")).toBe("position_x");
        expect(toSnakeCase("remotionPropsJson")).toBe("remotion_props_json");
        expect(toCamelCase("chroma_key_blend")).toBe("chromaKeyBlend");
        expect(toCamelCase(toSnakeCase("fadeInDuration"))).toBe("fadeInDuration");
    });
});

describe("builders", () => {
    it("builds closed object schemas", () => {
        expect(objectOf({ clip_id: str("Clip id."), steps: int() }, ["clip_id"])).toEqual({
            type: "object",
            properties: { clip_id: { type: "string", description: "Clip id." }, steps: { type: "integer" } },
            required: ["clip_id"],
            additionalProperties: false,
        });
        expect(enumOf(["a", "b"])).toEqual({ type: "string", enum: ["a", "b"] });
    });

    it("rejects a required key that is not a property", () => {
        expect(() => objectOf({ a: str() }, ["b"])).toThrow("required property b is not defined");
    });
});

describe("generated editor types", () => {
    it("lists every EditorCommand variant", () => {
        const types = editorCommandTypes();
        expect(types.length).toBeGreaterThanOrEqual(35);
        expect(types).toEqual(expect.arrayContaining(["clip.create", "clip.update", "scene.split", "history.undo", "ai.run"]));
        expect(commandSchema("clip.split")).toMatchObject({ required: ["type", "clipIds", "atSeconds"] });
        expect(commandSchema("nope")).toBeUndefined();
    });

    it("inlines every type (no $ref)", () => {
        expect(JSON.stringify(editorType("EditorCommand"))).not.toContain("$ref");
        expect(JSON.stringify(editorType("SceneData"))).not.toContain("$ref");
    });

    it("renames picked properties to snake_case and keeps their types", () => {
        const picked = snakeProperties(editorType("TimelineClip"), ["positionX", "mediaUrl"], { position_x: "Center X, 0-1." });
        expect(picked).toEqual({
            position_x: { type: "number", description: "Center X, 0-1." },
            media_url: { type: ["string", "null"] },
        });
        expect(() => snakeProperties(editorType("TimelineClip"), ["nope"])).toThrow("type has no property nope");
    });
});

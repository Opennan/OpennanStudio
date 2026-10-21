// Small JSON Schema builders and access to the generated editor type schemas.
import { EDITOR_TYPES, type EditorTypeName } from "./generated/editor-types";

export type JsonSchema = { [key: string]: unknown };

export interface ObjectSchema {
    [key: string]: unknown;
    type: "object";
    properties: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties: false;
    description?: string;
}

export type { EditorTypeName };

function described(schema: JsonSchema, description?: string): JsonSchema {
    return description ? { ...schema, description } : schema;
}

export const str = (description?: string): JsonSchema => described({ type: "string" }, description);
export const num = (description?: string): JsonSchema => described({ type: "number" }, description);
export const int = (description?: string): JsonSchema => described({ type: "integer" }, description);
export const bool = (description?: string): JsonSchema => described({ type: "boolean" }, description);
export const anyObject = (description?: string): JsonSchema => described({ type: "object", additionalProperties: true }, description);
export const arrayOf = (items: JsonSchema, description?: string): JsonSchema => described({ type: "array", items }, description);
export const enumOf = (values: readonly string[], description?: string): JsonSchema => described({ type: "string", enum: [...values] }, description);

export function objectOf(properties: Record<string, JsonSchema>, required: readonly string[] = [], description?: string): ObjectSchema {
    for (const key of required) {
        if (!(key in properties)) throw new Error(`required property ${key} is not defined`);
    }
    return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required: [...required] } : {}),
        additionalProperties: false,
        ...(description ? { description } : {}),
    };
}

/** positionX -> position_x */
export function toSnakeCase(name: string): string {
    return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** position_x -> positionX */
export function toCamelCase(name: string): string {
    return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The generated schema of a timeline-core type (src/generated/editor-types.ts). */
export function editorType(name: EditorTypeName): JsonSchema {
    return EDITOR_TYPES[name] as JsonSchema;
}

function commandVariants(): JsonSchema[] {
    return (editorType("EditorCommand").anyOf as JsonSchema[]) ?? [];
}

/** Every EditorCommand type, in declaration order. */
export function editorCommandTypes(): string[] {
    return commandVariants().map((variant) => ((variant.properties as Record<string, JsonSchema>).type.const as string));
}

/** The schema of one EditorCommand variant, e.g. commandSchema("clip.split"). */
export function commandSchema(type: string): JsonSchema | undefined {
    return commandVariants().find((variant) => (variant.properties as Record<string, JsonSchema>).type.const === type);
}

/**
 * Picks camelCase properties from a generated object schema and renames them to
 * snake_case tool arguments (OpenNan tool argument style). Throws when a key is
 * missing, so tool schemas break loudly when the model types change.
 */
export function snakeProperties(
    source: JsonSchema,
    keys: readonly string[],
    notes: Readonly<Record<string, string>> = {},
): Record<string, JsonSchema> {
    const properties = (source.properties ?? {}) as Record<string, JsonSchema>;
    const out: Record<string, JsonSchema> = {};
    for (const key of keys) {
        const property = properties[key];
        if (!property) throw new Error(`type has no property ${key}`);
        const snake = toSnakeCase(key);
        out[snake] = described(property, notes[snake]);
    }
    return out;
}

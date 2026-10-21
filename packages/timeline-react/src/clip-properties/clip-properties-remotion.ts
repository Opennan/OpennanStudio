// Pure helpers for the graphics (Remotion) clip inspector. Maps a template's
// param manifest plus the clip's stored props JSON into renderable controls.
import { templateById } from "../remotion/templates";

export interface RemotionParamControl {
    key: string;
    label: string;
    type: "text" | "color" | "number" | "select" | "json" | "colorArray" | "objectArray";
    value: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    invalidJson?: boolean;
    /**
     * colorArray/objectArray only: the stored prop holds a JSON *string* rather
     * than a real array, so the field must serialize back in the same shape it
     * came in.
     */
    arrayAsString?: boolean;
    /** objectArray only: the shared column set across every row. */
    columns?: ObjectArrayColumn[];
}

export interface ObjectArrayColumn {
    key: string;
    type: "text" | "number" | "color" | "boolean";
}

const COLOR_LITERAL = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

/** A json param whose value is a non-empty list of colour literals. */
function asColorArray(value: unknown): string[] | null {
    let parsed: unknown = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((entry) => typeof entry === "string" && COLOR_LITERAL.test(entry.trim()))) return null;
    return (parsed as string[]).map((entry) => entry.trim());
}

/**
 * A json param whose value is a non-empty list of flat objects sharing one key
 * set (chart data rows). Anything nested, ragged, or mixed-typed stays raw JSON.
 */
function asObjectArray(value: unknown): { rows: Record<string, unknown>[]; columns: ObjectArrayColumn[] } | null {
    let parsed: unknown = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 200) return null;
    const rows: Record<string, unknown>[] = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        rows.push(entry as Record<string, unknown>);
    }
    const keys = Object.keys(rows[0]);
    if (keys.length === 0 || keys.length > 8) return null;
    const columns: ObjectArrayColumn[] = [];
    for (const key of keys) {
        let type: ObjectArrayColumn["type"] | null = null;
        for (const row of rows) {
            if (!(key in row)) return null;
            const cell = row[key];
            let cellType: ObjectArrayColumn["type"];
            if (typeof cell === "number" && Number.isFinite(cell)) cellType = "number";
            else if (typeof cell === "boolean") cellType = "boolean";
            else if (typeof cell === "string") cellType = COLOR_LITERAL.test(cell.trim()) ? "color" : "text";
            else return null;
            // A column with any non-colour string is a plain text column.
            if (type === null) type = cellType;
            else if (type !== cellType) {
                if ((type === "color" && cellType === "text") || (type === "text" && cellType === "color")) type = "text";
                else return null;
            }
        }
        columns.push({ key, type: type ?? "text" });
    }
    // Rows carrying extra keys beyond the first row's would be silently dropped.
    if (rows.some((row) => Object.keys(row).length !== keys.length)) return null;
    return { rows, columns };
}

function parseStoredProps(propsJson: string | null | undefined): Record<string, unknown> {
    if (!propsJson) return {};
    try {
        const parsed = JSON.parse(propsJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        // An unparseable props blob falls back to template defaults rather
        // than hiding the whole section.
        return {};
    }
}

export function buildRemotionParamControls(
    templateId: string | null | undefined,
    propsJson: string | null | undefined,
): RemotionParamControl[] {
    const template = templateId ? templateById(templateId) : undefined;
    if (!template) return [];
    const stored = parseStoredProps(propsJson);
    return template.params.map((param) => {
        const value = param.key in stored ? stored[param.key] : param.default;
        const control: RemotionParamControl = {
            key: param.key,
            label: param.label,
            type: param.type,
            value,
            min: param.min,
            max: param.max,
            step: param.step,
            options: param.options,
        };
        if (param.type === "json") {
            const colors = asColorArray(value);
            if (colors) {
                control.type = "colorArray";
                control.value = colors;
                control.arrayAsString = typeof value === "string";
                return control;
            }
            const objects = asObjectArray(value);
            if (objects) {
                control.type = "objectArray";
                control.value = objects.rows;
                control.columns = objects.columns;
                control.arrayAsString = typeof value === "string";
                return control;
            }
        }
        if (param.type === "json" && typeof value === "string") {
            try {
                JSON.parse(value);
            } catch {
                // Preserve the raw string so the user can fix it in place.
                control.invalidJson = true;
            }
        }
        return control;
    });
}

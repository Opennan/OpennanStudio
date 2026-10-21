// A scene's drawn storyboard as Studio shows it (phase 9c): its sheets (each sheet's image, then its panels in order)
// from the scene's storyboardSheets (OpenNan cloud projects), else the panel images of its shots (phase 9b data: one
// sheet without an image), else nothing. Read only: only OpenNan draws storyboards.
import type { SceneData } from "@opennan/timeline-core";

export interface ShownSheet {
    imageUrl: string | null;
    panels: string[];
}

function shotPanels(shotBreakdown: string | null | undefined): string[] {
    if (!shotBreakdown) return [];
    try {
        const shots = JSON.parse(shotBreakdown) as unknown;
        if (!Array.isArray(shots)) return [];
        return shots
            .map((shot) => (shot && typeof shot === "object" && typeof (shot as { keyframe_url?: unknown }).keyframe_url === "string" ? (shot as { keyframe_url: string }).keyframe_url : null))
            .filter((url): url is string => Boolean(url));
    } catch {
        return [];
    }
}

export function storyboardOf(scene: Pick<Partial<SceneData>, "storyboardSheets" | "shotBreakdown">): ShownSheet[] {
    const sheets = (scene.storyboardSheets ?? [])
        .filter((sheet) => sheet && (typeof sheet.imageUrl === "string" || (Array.isArray(sheet.panels) && sheet.panels.length > 0)))
        .map((sheet) => ({
            imageUrl: typeof sheet.imageUrl === "string" && sheet.imageUrl ? sheet.imageUrl : null,
            panels: (Array.isArray(sheet.panels) ? sheet.panels : []).filter((p) => typeof p?.imageUrl === "string" && p.imageUrl).map((p) => p.imageUrl),
        }));
    if (sheets.length > 0) return sheets;
    const panels = shotPanels(scene.shotBreakdown);
    return panels.length > 0 ? [{ imageUrl: null, panels }] : [];
}

/** Every image of a storyboard in viewing order: each sheet's image, then its panels. */
export function storyboardImages(sheets: ShownSheet[]): Array<{ url: string; kind: "sheet" | "panel"; sheet: number; panel: number }> {
    const out: Array<{ url: string; kind: "sheet" | "panel"; sheet: number; panel: number }> = [];
    let panel = 0;
    sheets.forEach((sheet, s) => {
        if (sheet.imageUrl) out.push({ url: sheet.imageUrl, kind: "sheet", sheet: s, panel: -1 });
        for (const url of sheet.panels) out.push({ url, kind: "panel", sheet: s, panel: panel++ });
    });
    return out;
}

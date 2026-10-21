// Scenes whose shots were made on opennan.com (phase 9a.1): a cloud project's scene planned on the web keeps its shot
// list read only in Studio (the codec marks each shot readOnly). The inspector says so with a link, and the timeline
// offers no shot drag or Delete shot on such scenes; their shots are edited on opennan.com.
import type { SceneData } from "@opennan/timeline-core";

export function hasReadOnlyShots(scene: Pick<Partial<SceneData>, "shotBreakdown">): boolean {
    if (!scene.shotBreakdown) return false;
    try {
        const shots = JSON.parse(scene.shotBreakdown) as unknown;
        return Array.isArray(shots) && shots.some((shot) => typeof shot === "object" && shot !== null && (shot as { readOnly?: unknown }).readOnly === true);
    } catch {
        return false;
    }
}

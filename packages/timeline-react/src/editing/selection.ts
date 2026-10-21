// What the inspector and the libraries act on: the selected main-track scene, the selected layer clip,
// or the selected transition (store selection, live values).
import { selectLiveScenes, type SceneData, type TimelineClip } from "@opennan/timeline-core";
import { useEditorStore } from "../hooks/use-editor-store";

export type SelectionTarget =
    | { kind: "scene"; scene: SceneData }
    | { kind: "clip"; clip: TimelineClip }
    | { kind: "transition"; transition: { kind: "clip" | "scene"; id: string } }
    | null;

export function useSelectionTarget(): SelectionTarget {
    const sceneId = useEditorStore((s) => s.selectedSceneId);
    const clipId = useEditorStore((s) => s.selectedClipId);
    const transition = useEditorStore((s) => s.selectedTransition);
    const scene = useEditorStore((s) => (sceneId ? selectLiveScenes(s).find((sc) => sc.id === sceneId) ?? null : null));
    const clip = useEditorStore((s) => (clipId ? s.timelineData?.clips.find((c) => c.id === clipId) ?? null : null));
    if (transition) return { kind: "transition", transition };
    if (scene) return { kind: "scene", scene };
    if (clip) return { kind: "clip", clip };
    return null;
}

/** A target that takes a look (filter, adjust, effects): scenes and visual layer clips. */
export type LookTarget = { sceneId: string } | { clipId: string };

export function lookTargetOf(selection: SelectionTarget): LookTarget | null {
    if (selection?.kind === "scene") return { sceneId: selection.scene.id };
    if (selection?.kind === "clip" && (selection.clip.trackType === "video" || selection.clip.trackType === "sticker")) return { clipId: selection.clip.id };
    return null;
}

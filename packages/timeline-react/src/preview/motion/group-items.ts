// The selected items a preview group gesture transforms (phase 10c multi-select), captured at pointer-down from the
// compositor's boxes, and the ONE items.transform a gesture writes. Phase 10d: every selected item takes part. The
// group box (and its centre) comes from the items visible at the playhead; selected items that are not visible there
// ("followers": a clip outside its time range, a scene off the playhead) have no box, so they receive the gesture's
// deltas instead (items-plan.ts transformDeltaPatch: the move in frame fractions, the scale factor or the angle about
// the group centre), applied to their own base values and every keyframe of the touched channels as captured at the
// gesture's start, and written as absolute values (a coalesced live drag rewrites the same values, never adds up).
import type { EditorCommand } from "@opennan/timeline-core/controller/commands";
import {
    transformDeltaPatch, type ClipTransformPatch, type ItemTransform, type SceneTransformPatch, type TransformDelta,
} from "@opennan/timeline-core/controller/items-plan";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";
import { clipBaseAt, type FrameRect, type OverlayRect } from "./clip-motion";
import { clipTransformTarget, groupTransformCommand, sceneTransformTarget, type TransformChannel, type TransformTarget } from "./drag-commit";
import { applyGroupGesture, groupItemValues, type GroupGesture, type GroupItem } from "./group-transform";
import { boxFromRect, type HandleBox } from "./handles";
import { sceneCanTransform, type SceneHandleGeometry } from "./scene-handles";

export interface GroupSources {
    clips: readonly TimelineClip[];
    /** Timeline seconds. */
    time: number;
    frame: FrameRect;
    /** Visual boxes (with animation) and base boxes (keyframed/static values) of the drawn clips, by id. */
    visualRects: ReadonlyMap<string, OverlayRect>;
    baseRects: ReadonlyMap<string, OverlayRect>;
    /** Visible transformable scenes at the playhead with their boxes. */
    sceneBoxes: ReadonlyArray<{ sceneId: string; geometry: SceneHandleGeometry }>;
    sceneRanges: ReadonlyArray<{ scene: SceneData; start: number; duration: number }>;
    clipIds: ReadonlySet<string>;
    sceneIds: ReadonlySet<string>;
}

/** A selected item not visible at the playhead, as captured: it follows the gesture through a delta (scale: for the clamp). */
export interface GroupFollower {
    kind: "clip" | "scene";
    id: string;
    scale: number;
    item: TimelineClip | SceneData;
}

export interface GroupCapture {
    items: GroupItem[];
    /** Selected items not visible at the playhead (phase 10d). */
    followers?: GroupFollower[];
    /** Commit targets by `${kind}:${id}` (graphics commit as clips). */
    targets: Map<string, { target: TransformTarget; localTime: number }>;
    /** Visual boxes of the captured items (the group box is their union). */
    boxes: HandleBox[];
}

const keyOf = (item: Pick<GroupItem, "kind" | "id">) => `${item.kind === "scene" ? "scene" : "clip"}:${item.id}`;

/** Clips the preview transforms: text, stickers, graphics, and V2+ media clips. */
const transformableClip = (clip: TimelineClip) => clip.trackType === "text" || clip.trackType === "sticker" || clip.trackType === "remotion"
    || (clip.trackType === "video" && (clip.trackIndex ?? 2) >= 2 && Boolean(clip.mediaUrl));

const finiteOr = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The selected items visible at the playhead (their boxes make the group box) and the selected ones that are not (followers). */
export function collectGroupItems(src: GroupSources): GroupCapture {
    const items: GroupItem[] = [];
    const targets = new Map<string, { target: TransformTarget; localTime: number }>();
    const boxes: HandleBox[] = [];
    const { frame } = src;
    for (const id of src.clipIds) {
        const clip = src.clips.find((c) => c.id === id);
        const visual = src.visualRects.get(id);
        if (!clip || !visual || src.time < clip.startTime || src.time >= clip.endTime) continue;
        const localTime = src.time - clip.startTime;
        const base = clipBaseAt(clip, localTime);
        if (clip.trackType === "remotion") {
            // Graphics turn and scale about their layer centre: the frame centre plus the base position offset.
            items.push({
                kind: "graphics", id, posX: base.posX, posY: base.posY, scale: base.scale, rotation: base.rotation,
                pivot: { x: frame.x + frame.w / 2 + (base.posX - 0.5) * frame.w, y: frame.y + frame.h / 2 + (base.posY - 0.5) * frame.h },
            });
        } else {
            const rest = src.baseRects.get(id) ?? visual;
            const box = boxFromRect(rest);
            items.push({
                kind: "clip", id, posX: base.posX, posY: base.posY, scale: base.scale, rotation: base.rotation,
                pivot: { x: box.cx, y: box.cy }, anchor: { w: rest.anchorW ?? rest.w, h: rest.anchorH ?? rest.h },
            });
        }
        targets.set(`clip:${id}`, { target: clipTransformTarget(clip), localTime });
        boxes.push(boxFromRect(visual));
    }
    for (const id of src.sceneIds) {
        const entry = src.sceneBoxes.find((b) => b.sceneId === id);
        const range = src.sceneRanges.find((r) => r.scene.id === id);
        if (!entry || !range) continue;
        const { base, baseValues, visual } = entry.geometry;
        items.push({ kind: "scene", id, posX: baseValues.offsetX, posY: baseValues.offsetY, scale: baseValues.scale, rotation: baseValues.rotation, pivot: { x: base.cx, y: base.cy } });
        targets.set(`scene:${id}`, { target: sceneTransformTarget(range.scene, range.duration), localTime: src.time - range.start });
        boxes.push(visual);
    }
    const followers: GroupFollower[] = [];
    for (const id of src.clipIds) {
        const clip = src.clips.find((c) => c.id === id);
        if (!clip || targets.has(`clip:${id}`) || !transformableClip(clip)) continue;
        followers.push({ kind: "clip", id, scale: finiteOr(clip.scale, 1), item: clip });
    }
    for (const id of src.sceneIds) {
        const range = src.sceneRanges.find((r) => r.scene.id === id);
        if (!range || targets.has(`scene:${id}`) || !sceneCanTransform(range.scene)) continue;
        const scale = finiteOr(range.scene.transformScale, 1);
        followers.push({ kind: "scene", id, scale: scale > 0 ? scale : 1, item: range.scene });
    }
    return { items, targets, boxes, followers };
}

/** A follower's delta for a gesture (frame fractions; null when the gesture changes nothing). */
function followerDelta(gesture: GroupGesture, frame: FrameRect): TransformDelta | null {
    if (!(frame.w > 0) || !(frame.h > 0)) return null;
    if (gesture.kind === "move") {
        if (gesture.dx === 0 && gesture.dy === 0) return null;
        return { dx: round(gesture.dx / frame.w, 6), dy: round(gesture.dy / frame.h, 6) };
    }
    const center = { x: round((gesture.center.x - frame.x) / frame.w, 6), y: round((gesture.center.y - frame.y) / frame.h, 6) };
    const aspect = frame.w / frame.h;
    if (gesture.kind === "scale") return gesture.factor === 1 ? null : { scale: gesture.factor, center, aspect };
    return gesture.degrees === 0 ? null : { rotation: gesture.degrees, center, aspect };
}

const round = (value: number, digits: number) => {
    const f = 10 ** digits;
    return Math.round(value * f) / f || 0;
};

/** The items.transform for a gesture (a move writes positions only; scale adds scale, rotate adds rotation). */
export function groupGestureCommand(capture: GroupCapture, gesture: GroupGesture, frame: FrameRect): EditorCommand | null {
    const entries: Array<{ target: TransformTarget; values: Partial<Record<TransformChannel, number>>; localTime: number }> = [];
    for (const item of capture.items) {
        const commit = capture.targets.get(keyOf(item));
        if (!commit) continue;
        const values = groupItemValues(item, applyGroupGesture(item, gesture), frame);
        const written: Partial<Record<TransformChannel, number>> = { position_x: values.position_x, position_y: values.position_y };
        if (gesture.kind === "scale") written.scale = values.scale;
        if (gesture.kind === "rotate") written.rotation_degrees = values.rotation_degrees;
        entries.push({ target: commit.target, values: written, localTime: commit.localTime });
    }
    const command = groupTransformCommand(entries);
    const delta = capture.followers?.length ? followerDelta(gesture, frame) : null;
    if (!delta) return command;
    const clips: Array<ItemTransform<ClipTransformPatch>> = [];
    const scenes: Array<ItemTransform<SceneTransformPatch>> = [];
    for (const follower of capture.followers!) {
        const plan = transformDeltaPatch(follower.item, follower.kind, delta);
        if (!plan.ok || !plan.value) continue;
        const entry = { id: follower.id, ...plan.value };
        if (follower.kind === "clip") clips.push(entry as ItemTransform<ClipTransformPatch>);
        else scenes.push(entry as ItemTransform<SceneTransformPatch>);
    }
    if (clips.length === 0 && scenes.length === 0) return command;
    const base = command?.type === "items.transform" ? command : { type: "items.transform" as const, clips: [], scenes: [] };
    return { ...base, clips: [...(base.clips ?? []), ...clips], scenes: [...(base.scenes ?? []), ...scenes] };
}

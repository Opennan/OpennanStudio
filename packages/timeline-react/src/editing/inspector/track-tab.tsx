"use client";
// The Track tab (phase 10d): local motion tracking of a video clip or main-track scene. While the tab is open the
// preview draws the region box over the item (store.trackingRegion) — drag on the item to draw it, inside it to
// move it, its corners to resize; the X / Y / width / height sliders do the same from the keyboard. Track runs
// `tracking.run` (the host's decoder and worker) from the playhead's frame, with progress and Cancel; the result
// stays in the store for this session (store.trackingResult, not saved). Apply runs `tracking.apply` with the
// checked followers (overlapping text, stickers, graphics, and videos, or this item's mask): one undo step.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Crosshair, Square, X } from "lucide-react";
import type { SceneData, TimelineClip, TrackingOwner, TrackingReport, TrackingRunOutput } from "@opennan/timeline-core";
import type { TrackRegion } from "@opennan/timeline-core/tracking/tracker";
import { parseMask } from "@opennan/timeline-core/looks/masks";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { defaultTrackRegion } from "../../preview/motion/track-region";
import { Section, SliderRow } from "../controls";

export interface TrackedItemInfo {
    owner: TrackingOwner;
    /** Timeline seconds. */
    start: number;
    duration: number;
    item: TimelineClip | SceneData;
}

const EMPTY_CLIPS: TimelineClip[] = [];
const FOLLOWER_TYPES = new Set(["text", "sticker", "remotion", "video", "effect"]);
const sameOwner = (a: TrackingOwner | undefined, b: TrackingOwner) => Boolean(a) && JSON.stringify(a) === JSON.stringify(b);

function parseAspect(value: string | null | undefined): number {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? "");
    return match ? Number(match[1]) / Number(match[2]) : 16 / 9;
}

type Status =
    | { kind: "idle" }
    | { kind: "running"; progress: number }
    | { kind: "tracked"; frames: number; lost: number }
    | { kind: "applied"; report: TrackingReport }
    | { kind: "error"; message: string };

export function TrackTab({ tracked }: { tracked: TrackedItemInfo }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const ownerKey = JSON.stringify(tracked.owner);
    const aspect = parseAspect(useEditorStore((s) => s.projectMeta?.aspectRatio));
    const region = useEditorStore((s) => (s.trackingRegion && sameOwner(s.trackingRegion.owner, tracked.owner) ? s.trackingRegion.region : null));
    const result = useEditorStore((s) => (s.trackingResult && sameOwner(s.trackingResult.owner, tracked.owner) ? s.trackingResult : null));
    const clips = useEditorStore((s) => s.timelineData?.clips ?? EMPTY_CLIPS);
    const [status, setStatus] = useState<Status>({ kind: "idle" });
    const [checked, setChecked] = useState<Set<string>>(() => new Set());
    const abortRef = useRef<AbortController | null>(null);
    const statusId = useId();

    // The preview edits this item's box while the tab is open; the previous box of the same item is kept.
    useEffect(() => {
        const state = storeApi.getState();
        const owner = JSON.parse(ownerKey) as TrackingOwner;
        const previous = state.trackingRegion && sameOwner(state.trackingRegion.owner, owner) ? state.trackingRegion.region : null;
        state.setTrackingRegion({ owner, region: previous ?? defaultTrackRegion(aspect) });
        return () => {
            abortRef.current?.abort();
            storeApi.getState().setTrackingRegion(null);
        };
        // The aspect only sizes a first box.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storeApi, ownerKey]);

    const setRegion = (next: TrackRegion) => storeApi.getState().setTrackingRegion({ owner: tracked.owner, region: next });
    const end = tracked.start + tracked.duration;
    const ownerId = "clipId" in tracked.owner ? tracked.owner.clipId : null;
    const followers = useMemo(() => clips
        .filter((clip) => FOLLOWER_TYPES.has(clip.trackType) && clip.id !== ownerId && clip.startTime < end && clip.endTime > tracked.start)
        .sort((a, b) => a.trackType.localeCompare(b.trackType) || a.trackIndex - b.trackIndex || a.startTime - b.startTime), [clips, ownerId, end, tracked.start]);
    const hasMask = Boolean(parseMask(tracked.item.maskJson));

    const kindName = (clip: TimelineClip) => (clip.trackType === "text" ? t("itemText") : clip.trackType === "sticker" ? t("itemSticker")
        : clip.trackType === "remotion" ? t("itemGraphics") : clip.trackType === "effect" ? t("itemEffect") : t("itemVideo"));
    const clipName = (clip: TimelineClip) => clip.label || clip.textContent || kindName(clip);

    const runTrack = async () => {
        if (!region) return;
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        setStatus({ kind: "running", progress: 0 });
        const time = Math.min(tracked.duration, Math.max(0, storeApi.getState().currentTime - tracked.start));
        const outcome = await controller.execute(
            { type: "tracking.run", ...tracked.owner, region, time },
            { signal: abort.signal, toastOnError: false, onProgress: (p) => setStatus((s) => (s.kind === "running" && abortRef.current === abort ? { kind: "running", progress: p.progress ?? 0 } : s)) },
        );
        if (abortRef.current !== abort) return;
        abortRef.current = null;
        if (outcome.cancelled) {
            setStatus({ kind: "idle" });
            return;
        }
        if (!outcome.ok) {
            setStatus({ kind: "error", message: outcome.unavailable ? t("track_unavailable", { reason: outcome.error ?? "" }) : t("track_failed", { reason: outcome.error ?? "" }) });
            return;
        }
        const output = outcome.output as TrackingRunOutput;
        storeApi.getState().setTrackingResult({ owner: tracked.owner, samples: output.samples, source: output.source, fps: output.fps });
        setStatus({ kind: "tracked", frames: output.samples.length, lost: output.lost });
    };

    const cancel = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setStatus({ kind: "idle" });
    };

    const apply = async () => {
        if (!result) return;
        const list = [...checked].map((key) => (key === "mask" ? { mask: true } : { clipId: key }));
        if (list.length === 0) return;
        const outcome = await controller.execute({ type: "tracking.apply", ...tracked.owner, samples: result.samples, source: result.source, followers: list }, { toastOnError: false });
        if (!outcome.ok) {
            setStatus({ kind: "error", message: t("track_applyFailed", { reason: outcome.error ?? "" }) });
            return;
        }
        setStatus({ kind: "applied", report: outcome.output as TrackingReport });
    };

    const toggle = (key: string, on: boolean) => setChecked((current) => {
        const next = new Set(current);
        if (on) next.add(key);
        else next.delete(key);
        return next;
    });

    const running = status.kind === "running";
    const pct = (v: number) => t("percent", { value: v });
    const box = region ?? defaultTrackRegion(aspect);
    const slider = (key: keyof TrackRegion, label: string, testId: string, min: number, max: number) => (
        <SliderRow
            testId={testId} label={label} value={Math.round(box[key] * 1000) / 10} min={min} max={max} step={0.5} format={pct} disabled={running}
            onChange={(v) => {
                const value = v / 100;
                const next = { ...box, [key]: value };
                // Keep the box inside the picture: positions clamp to the size, sizes to the position.
                if (key === "x") next.x = Math.min(value, 1 - box.width);
                if (key === "y") next.y = Math.min(value, 1 - box.height);
                if (key === "width") next.x = Math.min(box.x, 1 - value);
                if (key === "height") next.y = Math.min(box.y, 1 - value);
                setRegion(next);
            }}
        />
    );

    return (
        <div className="on-track" data-testid="track-tab">
            <p className="on-hint">{t("track_hint")}</p>
            <Section title={t("track_region")}>
                {slider("x", t("positionX"), "track-region-x", 0, 98)}
                {slider("y", t("positionY"), "track-region-y", 0, 98)}
                {slider("width", t("mask_width"), "track-region-width", 2, 100)}
                {slider("height", t("mask_height"), "track-region-height", 2, 100)}
            </Section>
            <div className="on-row">
                {running ? (
                    <button type="button" className="on-btn" data-testid="track-cancel" onClick={cancel}><Square aria-hidden="true" />{t("track_cancel")}</button>
                ) : (
                    <button type="button" className="on-btn on-btn-primary" data-testid="track-run" disabled={!region} onClick={() => void runTrack()} aria-describedby={statusId}>
                        <Crosshair aria-hidden="true" />{result ? t("track_again") : t("track_run")}
                    </button>
                )}
                {result && !running && (
                    <button type="button" className="on-btn on-btn-ghost" data-testid="track-clear" onClick={() => { storeApi.getState().setTrackingResult(null); setStatus({ kind: "idle" }); }}>
                        <X aria-hidden="true" />{t("track_clear")}
                    </button>
                )}
            </div>
            {running && (
                <div
                    className="on-track-progress" role="progressbar" aria-label={t("track_progressLabel")} aria-valuemin={0} aria-valuemax={100}
                    aria-valuenow={Math.round(status.progress * 100)} data-testid="track-progress"
                >
                    <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </div>
            )}
            <p id={statusId} className="on-hint" role="status" aria-live="polite" data-testid="track-status">
                {status.kind === "running" && t("track_running", { percent: Math.round(status.progress * 100) })}
                {status.kind === "tracked" && t("track_done", { frames: status.frames, lost: status.lost })}
                {status.kind === "applied" && t("track_applied", { applied: status.report.applied.length, skipped: status.report.skipped.length })}
                {status.kind === "error" && status.message}
                {status.kind === "idle" && result && t("track_ready", { frames: result.samples.length })}
            </p>
            <fieldset className="on-attr-list on-track-followers" data-testid="track-followers" disabled={!result || running}>
                <legend className="on-track-legend">{t("track_followers")}</legend>
                <label className="on-attr-row" data-disabled={hasMask ? undefined : "true"}>
                    <input
                        type="checkbox" className="on-attr-check" data-testid="track-follower-mask" checked={hasMask && checked.has("mask")} disabled={!hasMask}
                        aria-describedby={hasMask ? undefined : `${statusId}-mask`} onChange={(e) => toggle("mask", e.currentTarget.checked)}
                    />
                    <span className="on-attr-name">{t("track_followerMask")}</span>
                    {!hasMask && <span id={`${statusId}-mask`} className="on-attr-hint">{t("track_needsMask")}</span>}
                </label>
                {followers.map((clip) => {
                    const movable = clip.trackType !== "effect";
                    const hintId = `${statusId}-${clip.id}`;
                    return (
                        <label key={clip.id} className="on-attr-row" data-disabled={movable ? undefined : "true"}>
                            <input
                                type="checkbox" className="on-attr-check" data-testid={`track-follower-${clip.id}`} checked={movable && checked.has(clip.id)} disabled={!movable}
                                aria-describedby={movable ? undefined : hintId} onChange={(e) => toggle(clip.id, e.currentTarget.checked)}
                            />
                            <span className="on-attr-name">{clipName(clip)}</span>
                            <span id={movable ? undefined : hintId} className="on-attr-hint">{movable ? kindName(clip) : t("track_noPosition")}</span>
                        </label>
                    );
                })}
                {followers.length === 0 && <p className="on-hint">{t("track_followersEmpty")}</p>}
            </fieldset>
            <button type="button" className="on-btn on-btn-primary" data-testid="track-apply" disabled={!result || running || checked.size === 0} onClick={() => void apply()}>
                {t("track_apply")}
            </button>
        </div>
    );
}

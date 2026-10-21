"use client";
// Auto cut to beat (phase 11): the selected clips and scenes re-timed so every cut lands on a beat of an audio clip
// (beats.autoCut, one undo step). Offered by the group inspector and the timeline menu of a multi-selection; disabled
// with the reason when no audio clip has beats yet (Detect beats first) or the planner refuses the selection.
import { useState } from "react";
import { Scissors } from "lucide-react";
import type { TimelineClip } from "@opennan/timeline-core";
import { parseBeatsJson, planAutoCut } from "@opennan/timeline-core/analysis/beat-plan";
import { useEditorStore } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineMessages } from "../hooks/use-timeline-messages";

const EMPTY_CLIPS: TimelineClip[] = [];

export interface AutoCutItems {
    clipIds: readonly string[];
    sceneIds: readonly string[];
}

/** Audio clips that carry beats are the beat source, never cut themselves. */
export function autoCutTargets(clips: readonly TimelineClip[], items: AutoCutItems): { clipIds: string[]; sceneIds: string[] } {
    const beatSources = new Set(clips.filter((c) => c.trackType === "audio" && parseBeatsJson(c.beatsJson).length > 0).map((c) => c.id));
    return { clipIds: items.clipIds.filter((id) => !beatSources.has(id)), sceneIds: [...items.sceneIds] };
}

/** Whether auto cut can run on these items, why not, and the run itself. */
export function useAutoCut(items: AutoCutItems) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const clips = useEditorStore((s) => s.timelineData?.clips ?? EMPTY_CLIPS);
    const hasBeats = clips.some((c) => c.trackType === "audio" && parseBeatsJson(c.beatsJson).length > 0);
    const targets = autoCutTargets(clips, items);
    let reason: string | null = null;
    if (!hasBeats) reason = t("ai_autoCutNoBeats");
    else {
        const plan = planAutoCut(controller.snapshot(), targets);
        if (!plan.ok) reason = plan.error;
    }
    const run = () => controller.execute({ type: "beats.autoCut", clipIds: targets.clipIds, sceneIds: targets.sceneIds }, { toastOnError: false });
    return { reason, run };
}

/** The group inspector's Auto cut to beat section body. */
export function AutoCutToBeat({ items }: { items: AutoCutItems }) {
    const t = useTimelineMessages("studioEditor");
    const { reason, run } = useAutoCut(items);
    const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
    const cut = async () => {
        const outcome = await run();
        if (!outcome.ok) {
            setMessage({ error: true, text: t("ai_autoCutFailed", { reason: outcome.error ?? "" }) });
            return;
        }
        const output = outcome.output as { snapped?: number } | undefined;
        setMessage({ error: false, text: t("ai_autoCutDone", { snapped: output?.snapped ?? 0 }) });
    };
    return (
        <div className="on-ai-action" data-testid="ai-auto-cut">
            <p className="on-ai-desc">{t("ai_autoCutDesc")}</p>
            <button type="button" className="on-btn on-btn-primary on-ai-run" data-testid="ai-auto-cut-run" disabled={Boolean(reason)} aria-description={reason ?? undefined} onClick={() => void cut()}>
                <Scissors aria-hidden="true" />{t("ai_autoCutRun")}
            </button>
            {reason && <p className="on-ai-reason" data-testid="ai-auto-cut-reason">{reason}</p>}
            {message && <p className={message.error ? "on-ai-error" : "on-ai-summary"} role="status" data-testid="ai-auto-cut-status">{message.text}</p>}
            <p className="on-ai-note">{t("ai_localNote")}</p>
        </div>
    );
}

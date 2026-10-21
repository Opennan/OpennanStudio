"use client";
// Public <ClipProperties>: reads the clip from the store and writes through the
// controller. The AI callbacks stay optional props until providers exist (phase 8).
import type { ComponentProps } from "react";
import { useEditorStore } from "../hooks/use-editor-store";
import { useTimelineCommandAdapters } from "../timeline/adapters";
import { ClipProperties as ClipPropertiesView } from "./clip-properties";

type ViewProps = ComponentProps<typeof ClipPropertiesView>;

export interface ClipPropertiesPanelProps extends Pick<ViewProps, "onGenerateAiClip" | "onProcessAudioClip" | "onEditRemotionClip" | "aiModels"> {
    /** Defaults to the selected clip. */
    clipId?: string;
    className?: string;
}

export function ClipProperties({ clipId, className, ...ai }: ClipPropertiesPanelProps) {
    const selectedClipId = useEditorStore((s) => s.selectedClipId);
    const id = clipId ?? selectedClipId;
    const clip = useEditorStore((s) => (id ? s.timelineData?.clips.find((c) => c.id === id) ?? null : null));
    const { onUpdateClip, onDeleteClip } = useTimelineCommandAdapters();
    if (!clip) return null;
    return (
        <div className={className}>
            <ClipPropertiesView clip={clip} onUpdateClip={onUpdateClip} onDeleteClip={(target) => { void onDeleteClip(target); }} {...ai} />
        </div>
    );
}

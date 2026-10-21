"use client";
// Public <Timeline>: NleTimeline inside the error boundary the host used to add
// (editor-layout.tsx:3934-3970). Data and writes come from <TimelineProvider>.
import { forwardRef, type ErrorInfo } from "react";
import { NleTimeline } from "./nle-timeline";
import { TimelineErrorBoundary } from "../parts/timeline-error-boundary";
import type { TimelineHandle } from "./timeline-handle";
import { AttributePastePicker } from "../editing/attributes/attribute-paste-picker";

export interface TimelineProps {
    className?: string;
    /** Turn off this instance's keyboard shortcuts (several editors on one page). */
    shortcutsEnabled?: boolean;
    onError?(error: Error, info: ErrorInfo): void;
}

export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline({ className, shortcutsEnabled, onError }, ref) {
    return (
        <TimelineErrorBoundary onError={onError}>
            <div className={className}>
                <NleTimeline ref={ref} shortcutsEnabled={shortcutsEnabled} />
                {/* Opened by the context menus, the inspector, and ⌥⌘V (store attributePastePicker). */}
                <AttributePastePicker />
            </div>
        </TimelineErrorBoundary>
    );
});

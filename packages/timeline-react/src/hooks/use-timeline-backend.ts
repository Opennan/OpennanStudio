import { useContext } from "react";
import type { TimelineBackend } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

export function useTimelineBackend(): { backend: TimelineBackend; projectId: string } {
    const runtime = useContext(TimelineContext) ?? getActiveRuntime();
    if (!runtime) throw new Error("useTimelineBackend must be used inside <TimelineProvider>");
    return { backend: runtime.backend, projectId: runtime.projectId };
}

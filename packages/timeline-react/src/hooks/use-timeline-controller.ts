import { useContext } from "react";
import type { TimelineController } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

export function useTimelineController(): TimelineController {
    const controller = useContext(TimelineContext)?.controller ?? getActiveRuntime()?.controller;
    if (!controller) throw new Error("useTimelineController must be used inside <TimelineProvider>");
    return controller;
}

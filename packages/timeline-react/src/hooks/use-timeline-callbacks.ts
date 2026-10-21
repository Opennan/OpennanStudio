import { useContext } from "react";
import { TimelineContext, type TimelineHostCallbacks } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

const NONE: TimelineHostCallbacks = {};

export function useTimelineCallbacks(): TimelineHostCallbacks {
    return useContext(TimelineContext)?.callbacks ?? getActiveRuntime()?.callbacks ?? NONE;
}

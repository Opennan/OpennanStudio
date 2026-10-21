import { useContext } from "react";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";
import { NOOP_TOAST, type TimelineToastApi } from "../provider/toast";

export function useTimelineToast(): TimelineToastApi {
    return useContext(TimelineContext)?.toast ?? getActiveRuntime()?.toast ?? NOOP_TOAST;
}

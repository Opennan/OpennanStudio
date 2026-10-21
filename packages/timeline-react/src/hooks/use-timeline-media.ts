import { useContext } from "react";
import { DEFAULT_TIMELINE_THEME, type TimelineTheme } from "@opennan/timeline-core";
import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "@opennan/timeline-media";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

export function useTimelineMedia(): MediaEnvironment {
    return useContext(TimelineContext)?.media ?? getActiveRuntime()?.media ?? IDENTITY_MEDIA_ENVIRONMENT;
}

export function useTimelineConfig(): { debugHooks: boolean; portalContainer: HTMLElement | null; theme: TimelineTheme } {
    const runtime = useContext(TimelineContext) ?? getActiveRuntime();
    return {
        debugHooks: runtime?.debugHooks ?? false,
        portalContainer: runtime?.portalContainer ?? (typeof document !== "undefined" ? document.body : null),
        theme: runtime?.theme ?? DEFAULT_TIMELINE_THEME,
    };
}

export function usePortalContainer(): HTMLElement | null {
    return useTimelineConfig().portalContainer;
}

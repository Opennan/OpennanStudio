import { useCallback, useContext } from "react";
import type { TimelineNamespace } from "../i18n/en";
import { DEFAULT_TRANSLATE, type MessageKey, type MessageValues, type TimelineTranslate } from "../i18n/format";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

export function useTimelineTranslate(): TimelineTranslate {
    return useContext(TimelineContext)?.translate ?? getActiveRuntime()?.translate ?? DEFAULT_TRANSLATE;
}

/** useTranslations-style t(key, values) for one namespace; stable across renders. */
export function useTimelineMessages<N extends TimelineNamespace>(namespace: N): (key: MessageKey<N>, values?: MessageValues) => string {
    const translate = useTimelineTranslate();
    return useCallback((key: MessageKey<N>, values?: MessageValues) => translate(namespace, key, values), [translate, namespace]);
}

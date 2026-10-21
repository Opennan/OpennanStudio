"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    TimelineController, createEditorStore, resolveTimelineTheme,
    type EditorCommandType, type EditorStore, type MediaAnalyzerHost, type MotionTrackerHost, type TimelineBackend, type TimelineControllerOptions, type TimelineThemeOverrides, type TimelineToast,
} from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";
import { createTranslator, mergeMessages, type TimelineMessagesOverrides, type TimelineTranslate } from "../i18n/format";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { TimelineContext, type OverlayAnchorsRegistry, type TimelineContextValue, type TimelineHostCallbacks } from "./context";
import { createMotionTrackerHost } from "../tracking/motion-tracker-host";
import { createBrowserAnalyzer } from "../analysis/browser-analyzer";
import type { TimelineMarkerStorage } from "./marker-storage";
import { registerActiveRuntime } from "./registry";
import { createToastApi } from "./toast";
import { TooltipProvider } from "../ui/tooltip";
import type { TimelineAiHost } from "../ai/ai-host";

export interface TimelineProviderProps extends TimelineHostCallbacks {
    backend: TimelineBackend;
    projectId: string;
    media: MediaEnvironment;
    store?: EditorStore;
    controller?: TimelineController;
    messages?: TimelineMessagesOverrides;
    locale?: string;
    translate?: TimelineTranslate;
    theme?: TimelineThemeOverrides;
    onToast?(toast: TimelineToast): string | void;
    onDismissToast?(id: string): void;
    portalContainer?: HTMLElement | null;
    debugHooks?: boolean;
    /** Per-project marker persistence (markers are view state, not backend data). Default: none. */
    markerStorage?: TimelineMarkerStorage;
    /** Load project, timeline, and scenes on mount (default true). */
    autoLoad?: boolean;
    /**
     * Runs the `export.start` command (wire @opennan/export here). Without it the command is unavailable. A `cancel`
     * method on the handler runs `export.cancel` (phase 10d).
     */
    onExport?: TimelineControllerOptions["onExport"] & { cancel?: TimelineControllerOptions["onExportCancel"] };
    /**
     * Runs the `ai.run` command (pass @opennan/provider-sdk's createAiRunner(registry)). Without it the command
     * is unavailable.
     */
    onAiRun?: TimelineControllerOptions["onAiRun"];
    /**
     * Runs `tracking.run` (phase 10d). Default: the browser tracker (mediabunny decoding through `media`, the tracker in
     * a worker); null turns motion tracking off (the command reports unavailable).
     */
    motionTracker?: MotionTrackerHost | null;
    /**
     * Runs `analysis.run` (phase 11: silences, beats). Default: the browser analyzer (mediabunny decoding through
     * `media`, detectors in a worker); null turns local analysis off (the command reports unavailable).
     */
    analyzer?: MediaAnalyzerHost | null;
    /** AI in the editor (phase 11): prices, sign-in, the job queue, and placement, from the host's providers. */
    ai?: TimelineAiHost | null;
    children: ReactNode;
}

// Controller failures use the same message keys the components used (en.json:1851-1875).
const ERROR_KEYS: Partial<Record<EditorCommandType, [string, string]>> = {
    "clip.create": ["timeline", "clipCreateFailed"],
    "clip.update": ["timeline", "clipUpdateFailed"],
    "clip.updateMany": ["timeline", "clipUpdateFailed"],
    "clip.move": ["timeline", "clipUpdateFailed"],
    "clip.effect.add": ["timeline", "clipUpdateFailed"],
    "clip.effect.update": ["timeline", "clipUpdateFailed"],
    "clip.delete": ["timeline", "deleteFailed"],
    "scene.move": ["timeline", "couldNotSavePositions"],
    "scene.trim": ["timeline", "couldNotSavePositions"],
    "scene.reorder": ["timeline", "couldNotSavePositions"],
    "scene.split": ["timeline", "sceneSplitFailed"],
    "scene.add": ["timeline", "clipCreateFailed"],
    "scene.delete": ["timeline", "deleteFailed"],
};

function localizedErrorMessages(getTranslate: () => TimelineTranslate): Partial<Record<EditorCommandType, string>> {
    const out: Partial<Record<EditorCommandType, string>> = {};
    for (const [type, [namespace, key]] of Object.entries(ERROR_KEYS) as Array<[EditorCommandType, [string, string]]>) {
        Object.defineProperty(out, type, { enumerable: true, get: () => getTranslate()(namespace, key) });
    }
    return out;
}

function useLatest<T>(value: T) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}

function usePortalElement(explicit: HTMLElement | null | undefined): HTMLElement | null {
    const [element, setElement] = useState<HTMLElement | null>(explicit ?? null);
    useEffect(() => {
        if (explicit !== undefined) {
            setElement(explicit);
            return;
        }
        const node = document.createElement("div");
        node.className = "opennan-studio-portal";
        node.setAttribute("data-on-theme", "dark");
        document.body.appendChild(node);
        setElement(node);
        return () => {
            node.remove();
        };
    }, [explicit]);
    return element;
}

export function TimelineProvider(props: TimelineProviderProps) {
    const { backend, projectId, media, children } = props;
    const [ownedStore] = useState(() => props.store ?? createEditorStore());
    const store = props.store ?? ownedStore;
    const locale = props.locale ?? "en";
    const translate = useMemo(
        () => props.translate ?? createTranslator(mergeMessages(props.messages), locale),
        [props.translate, props.messages, locale],
    );
    const translateRef = useLatest(translate);
    const onToastRef = useLatest(props.onToast);
    const onDismissRef = useLatest(props.onDismissToast);
    const callbacksRef = useLatest<TimelineHostCallbacks>(props);
    const onExportRef = useLatest(props.onExport);
    const onAiRunRef = useLatest(props.onAiRun);
    const motionTrackerRef = useLatest(props.motionTracker);
    const analyzerRef = useLatest(props.analyzer);
    const mediaRef = useLatest(media);
    const [overlayAnchors] = useState<OverlayAnchorsRegistry>(() => ({ current: null }));
    // The browser tracker, made on first use (it resolves media through the latest environment).
    const defaultTrackerRef = useRef<MotionTrackerHost | null>(null);
    // The browser analyzer, made on first use like the tracker.
    const defaultAnalyzerRef = useRef<MediaAnalyzerHost | null>(null);

    const toast = useMemo(() => createToastApi(() => onToastRef.current, () => onDismissRef.current), [onToastRef, onDismissRef]);
    const callbacks = useMemo<TimelineHostCallbacks>(() => ({
        onOpenChatEdit: (r) => callbacksRef.current.onOpenChatEdit?.(r),
        onOpenMusicPanel: (r) => callbacksRef.current.onOpenMusicPanel?.(r),
        onOpenSceneDetails: (r) => callbacksRef.current.onOpenSceneDetails?.(r),
        onOpenClipEdit: (r) => callbacksRef.current.onOpenClipEdit?.(r),
        onOpenSceneEdit: (r) => callbacksRef.current.onOpenSceneEdit?.(r),
        onSuggestChatReference: (r) => callbacksRef.current.onSuggestChatReference?.(r),
        onSaveToSources: (m) => callbacksRef.current.onSaveToSources?.(m),
        onInspect: (t) => callbacksRef.current.onInspect?.(t),
    }), [callbacksRef]);

    const ownsController = !props.controller;
    const controller = useMemo(
        () => props.controller ?? new TimelineController({
            backend,
            store,
            projectId,
            onToast: (t) => onToastRef.current?.(t),
            errorMessages: localizedErrorMessages(() => translateRef.current),
            onExport: (options, snapshot) => onExportRef.current?.(options, snapshot)
                ?? Promise.resolve({ unavailable: true, error: "export.start needs a TimelineProvider onExport handler" }),
            onExportCancel: (jobId) => onExportRef.current?.cancel?.(jobId)
                ?? Promise.resolve({ unavailable: true, error: "export.cancel needs an export handler with cancel" }),
            onAiRun: (request, context) => onAiRunRef.current?.(request, context)
                ?? Promise.resolve({ unavailable: true, error: `ai.run needs a provider for ${request.capability} (spec §5.4)` }),
            motionTracker: {
                track: (job, context) => {
                    const chosen = motionTrackerRef.current;
                    if (chosen === null) return Promise.resolve({ unavailable: true, error: "motion tracking is turned off in this editor" });
                    const host = chosen ?? (defaultTrackerRef.current ??= createMotionTrackerHost({ media: { resolveMediaUrl: (url) => mediaRef.current.resolveMediaUrl(url) } }));
                    return host.track(job, context);
                },
                anchors: (clipIds) => motionTrackerRef.current?.anchors?.(clipIds) ?? overlayAnchors.current?.(clipIds) ?? {},
            },
            analyzer: {
                analyze: (job, context) => {
                    const chosen = analyzerRef.current;
                    if (chosen === null) return Promise.resolve({ unavailable: true, error: "local analysis is turned off in this editor" });
                    const host = chosen ?? (defaultAnalyzerRef.current ??= createBrowserAnalyzer({ media: { resolveMediaUrl: (url) => mediaRef.current.resolveMediaUrl(url) } }));
                    return host.analyze(job, context);
                },
            },
        }),
        [props.controller, backend, store, projectId, onToastRef, translateRef, onExportRef, onAiRunRef, motionTrackerRef, analyzerRef, mediaRef, overlayAnchors],
    );

    // Declared before the load effect. StrictMode (development) runs this cleanup once
    // and mounts again with the same memoized controller; resume() undoes that dispose().
    useEffect(() => {
        if (ownsController) controller.resume();
        return () => {
            if (ownsController) controller.dispose();
        };
    }, [controller, ownsController]);
    useEffect(() => {
        if (props.autoLoad === false) return;
        void controller.load().catch(() => undefined);
    }, [controller, props.autoLoad]);

    // Markers persist per project through the host (editor-layout.tsx:482-494).
    const markerStorage = props.markerStorage;
    useEffect(() => {
        if (!markerStorage) return;
        const persisted = markerStorage.load(projectId);
        if (persisted.length > 0) store.getState().setTimelineMarkers(persisted);
        const unsubscribe = store.subscribe((s) => s.timelineMarkers, (markers) => markerStorage.save(projectId, markers));
        return () => {
            unsubscribe();
            store.getState().clearTimelineMarkers();
        };
    }, [markerStorage, projectId, store]);

    const visible = useDocumentVisible();
    useEffect(() => {
        controller.setActive(visible);
    }, [controller, visible]);

    useEffect(() => store.subscribe(
        (s) => [s.selectedClipId, s.selectedSceneId, s.selectedTransition, s.selectedAudioTarget] as const,
        ([clipId, sceneId, transition, audioTarget]) => {
            if (clipId) callbacks.onInspect?.({ kind: "clip", id: clipId });
            else if (sceneId) callbacks.onInspect?.({ kind: "scene", id: sceneId });
            else if (transition) callbacks.onInspect?.({ kind: "transition", id: transition.id, transitionKind: transition.kind });
            else if (audioTarget) callbacks.onInspect?.({ kind: "audio", target: audioTarget });
        },
        { equalityFn: (a, b) => a.every((value, i) => value === b[i]) },
    ), [store, callbacks]);

    const theme = useMemo(() => resolveTimelineTheme(props.theme), [props.theme]);
    const portalContainer = usePortalElement(props.portalContainer);

    const value = useMemo<TimelineContextValue>(() => ({
        controller, store, backend, projectId, media, translate, locale, theme, toast, callbacks,
        portalContainer, debugHooks: props.debugHooks ?? false, overlayAnchors, ai: props.ai ?? null,
    }), [controller, store, backend, projectId, media, translate, locale, theme, toast, callbacks, portalContainer, props.debugHooks, overlayAnchors, props.ai]);

    useEffect(() => registerActiveRuntime(value), [value]);

    return (
        <TimelineContext.Provider value={value}>
            <TooltipProvider delay={0}>
                <div className="opennan-studio" data-on-theme="dark" style={{ display: "contents" }}>
                    {children}
                </div>
            </TooltipProvider>
        </TimelineContext.Provider>
    );
}

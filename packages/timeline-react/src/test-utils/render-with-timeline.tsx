// Test helpers: a TimelineProvider over a recording LocalBackend.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi, type Mock } from "vitest";
import {
    LocalBackend, createMemoryPersistence,
    type EditorStore, type MediaAnalyzerHost, type MotionTrackerHost, type SceneData, type TimelineBackend, type TimelineClip, type TimelineToast, type TimelineTrack,
} from "@opennan/timeline-core";
import { createRecordingBackend, type RecordingBackend } from "@opennan/timeline-core/testing";
import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "@opennan/timeline-media";
import { TimelineProvider } from "../provider/timeline-provider";
import type { TimelineHostCallbacks } from "../provider/context";
import { getActiveEditorStore } from "../provider/registry";
import { DEFAULT_TRANSLATE, type TimelineTranslate } from "../i18n/format";
import type { TimelineAiHost } from "../ai/ai-host";

/** Same key echo the source tests' i18n mock returned (nle-timeline-deselect.test.tsx:8-12). */
export const keyEcho: TimelineTranslate = (_namespace, key, values) => (values?.n !== undefined && values?.n !== null ? `${key}:${values.n}` : key);

/** Plain key echo (canvas-timeline.selection.test.tsx:9-11 ignored values). */
export const keyOnly: TimelineTranslate = (_namespace, key) => key;

/** Key echo, except listed keys render their English default (tests that find text by English). */
export function keyEchoExcept(englishKeys: string[], base: TimelineTranslate = keyOnly): TimelineTranslate {
    const english = new Set(englishKeys);
    return (namespace, key, values) => (english.has(key) ? DEFAULT_TRANSLATE(namespace, key, values) : base(namespace, key, values));
}

export interface TimelineTestRuntime {
    local: LocalBackend;
    recording: RecordingBackend;
    backend: TimelineBackend;
    store: EditorStore;
    onToast: Mock<(toast: TimelineToast) => string | void>;
    projectId: string;
}

export function createTimelineTestRuntime(options: { store?: EditorStore; projectId?: string } = {}): TimelineTestRuntime {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `srv-${++n}` });
    const recording = createRecordingBackend(local);
    return {
        local,
        recording,
        backend: recording.backend,
        // Default: the registry's active (or fallback) store, the one seeded tests reach
        // through getActiveEditorStore() before and after rendering.
        store: options.store ?? getActiveEditorStore(),
        onToast: vi.fn<(toast: TimelineToast) => string | void>(),
        projectId: options.projectId ?? "project-1",
    };
}

/** Seeds the same data into the LocalBackend and the store, so commands persist. */
export async function seedTimeline(runtime: TimelineTestRuntime, data: { tracks?: TimelineTrack[]; clips?: TimelineClip[]; scenes?: SceneData[] }): Promise<void> {
    await runtime.local.seedProject(runtime.projectId, data);
    const s = runtime.store.getState();
    s.setTimelineData(await runtime.local.loadTimeline(runtime.projectId));
    s.replaceServerScenes(await runtime.local.loadScenes(runtime.projectId));
}

export interface RenderWithTimelineOptions extends Partial<TimelineHostCallbacks> {
    runtime?: TimelineTestRuntime;
    translate?: TimelineTranslate;
    media?: MediaEnvironment;
    autoLoad?: boolean;
    /** TimelineProvider motionTracker (phase 10d). */
    motionTracker?: MotionTrackerHost | null;
    /** TimelineProvider analyzer (phase 11). */
    analyzer?: MediaAnalyzerHost | null;
    /** TimelineProvider ai (phase 11). */
    ai?: TimelineAiHost | null;
}

export function renderWithTimeline(ui: ReactElement, options: RenderWithTimelineOptions = {}): RenderResult & TimelineTestRuntime {
    const { runtime: given, translate, media, autoLoad, ...callbacks } = options;
    const runtime = given ?? createTimelineTestRuntime();
    // The provider goes in RTL's `wrapper`, which rerender() keeps, so tests that rerender
    // with new props keep the same provider, store, and controller
    // (canvas-timeline.selection.test.tsx:120-132 rerenders a bare <CanvasTimeline>).
    function Wrapper({ children }: { children: ReactNode }) {
        return (
            <TimelineProvider
                backend={runtime.backend}
                projectId={runtime.projectId}
                media={media ?? IDENTITY_MEDIA_ENVIRONMENT}
                store={runtime.store}
                translate={translate ?? keyEcho}
                onToast={runtime.onToast}
                autoLoad={autoLoad ?? false}
                {...callbacks}
            >
                {children}
            </TimelineProvider>
        );
    }
    const result = render(ui, { wrapper: Wrapper });
    return Object.assign(result, runtime);
}

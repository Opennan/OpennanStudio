// Test fixture: a small project on an in-memory LocalBackend behind a StudioSession.
import {
    LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, optimistic,
    type EffectDef, type FrameRenderer, type LocalProjectState, type MediaAnalyzerHost, type MotionTrackerHost, type SceneData,
} from "@opennan/timeline-core";
import type { ExportRunner } from "@opennan/export";
import { createStudioExporter, type StudioExporter } from "../export";
import { createControllerSession, type StudioHost, type StudioSession } from "../session";

export const FIXTURE_PROJECT_ID = "fixture";

export const FIXTURE_EFFECTS: EffectDef[] = [{
    id: "blur", name: "Blur", kind: "effect", category: "basic", glsl: "", thumbnail: null, ownerScope: "system",
    params: [{ key: "amount", label: "Amount", type: "slider", min: 0, max: 1, default: 0.5 }],
}];

function scene(id: string, order: number, fields: Partial<SceneData>): SceneData {
    return {
        id, order, caption: "", startTime: "00:00:00", endTime: "00:00:00", startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, shotBreakdown: "[]", trackIndex: 1, ...fields,
    };
}

/**
 * Scenes end to end on V1: s1 0-4 s (source clip), s2 4-10 s (two 3 s shots), s3 10-15 s.
 * Clips: "Title" text 0-3 s on T1, "Music" audio 0-15 s on A1.
 */
export function fixtureProject(): LocalProjectState {
    const clip = (id: string, input: Record<string, unknown>) => optimistic.optimisticTimelineClipFromInput(input, FIXTURE_PROJECT_ID, id);
    return {
        meta: { id: FIXTURE_PROJECT_ID, name: "Fixture", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" },
        tracks: [
            { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 },
        ],
        clips: [
            clip("title", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", label: "Title" }),
            clip("music", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 15, mediaUrl: "https://media.test/music.mp3", label: "Music" }),
        ],
        scenes: [
            scene("s1", 0, { caption: "Intro", duration: 4, cardType: "source_clip", videoUrl: "https://media.test/a.mp4", sourceVideoUrl: "https://media.test/a.mp4" }),
            scene("s2", 1, {
                caption: "Middle", duration: 6, cardType: "ai_video",
                shotBreakdown: JSON.stringify([{ prompt: "wide", duration: "3" }, { prompt: "close", duration: "3", speech: "hi" }]),
            }),
            scene("s3", 2, { caption: "End", duration: 5, cardType: "image", startImageUrl: "https://media.test/end.png" }),
        ],
    };
}

export interface FixtureStudio {
    backend: LocalBackend;
    controller: TimelineController;
    store: ReturnType<typeof createEditorStore>;
    session: StudioSession;
    /** Set when the fixture was created with an exportRunner. */
    exporter?: StudioExporter;
}

export interface FixtureOptions {
    frameRenderer?: FrameRenderer;
    host?: StudioHost;
    /** Wires createStudioExporter: export.start (and previewFrame, unless frameRenderer is given) run on it. */
    exportRunner?: ExportRunner;
    /** The controller's motion tracker (tracking.run); without it tracking is unavailable, as in headless hosts. */
    motionTracker?: MotionTrackerHost;
    /** The controller's audio analyzer (analysis.run); without it silences and beats are unavailable. */
    analyzer?: MediaAnalyzerHost;
}

export async function createFixtureStudio(options: FixtureOptions = {}): Promise<FixtureStudio> {
    let n = 0;
    const backend = new LocalBackend({
        persistence: createMemoryPersistence(),
        idFactory: () => `id-${++n}`,
        effectCatalog: FIXTURE_EFFECTS,
        createObjectUrl: () => "blob:fixture",
    });
    await backend.seedProject(FIXTURE_PROJECT_ID, fixtureProject());
    const store = createEditorStore();
    const exporter = options.exportRunner
        ? createStudioExporter({ runner: options.exportRunner, effects: () => backend.listEffects("effect") })
        : undefined;
    const controller = new TimelineController({
        backend, store, projectId: FIXTURE_PROJECT_ID,
        frameRenderer: options.frameRenderer ?? exporter?.frameRenderer,
        onExport: exporter?.onExport,
        onExportCancel: exporter?.onExportCancel,
        motionTracker: options.motionTracker,
        analyzer: options.analyzer,
    });
    await controller.load();
    const session = createControllerSession({ controller, store, backend, host: options.host, exporter });
    return { backend, controller, store, session, exporter };
}

/**
 * A stand-in motion tracker: the region's centre moves right by 0.05 of the picture per second of item time (and
 * down by 0.02), every frame confident; the picture is 1920×1080.
 */
export function createFakeMotionTracker(): MotionTrackerHost {
    return {
        async track(job, context) {
            const cx = job.region.x + job.region.width / 2;
            const cy = job.region.y + job.region.height / 2;
            const t0 = job.frames[job.startIndex].time;
            context.onProgress?.(1);
            return {
                samples: job.frames.map((f) => ({ time: f.time, x: cx + 0.05 * (f.time - t0), y: cy + 0.02 * (f.time - t0), confidence: 0.97, lost: false })),
                source: { width: 1920, height: 1080 },
            };
        },
    };
}

/**
 * A stand-in audio analyzer: silences at source seconds 2-3 and 8-9 of every range (those inside it), and a beat
 * every 0.5 s at 120 BPM.
 */
export function createFakeAnalyzer(): MediaAnalyzerHost {
    return {
        async analyze(job, context) {
            context.onProgress?.(1);
            if (job.kind === "silences") {
                return { silences: [{ start: 2, end: 3 }, { start: 8, end: 9 }].filter((r) => r.start >= job.startSeconds && r.end <= job.endSeconds) };
            }
            const times: number[] = [];
            for (let t = Math.ceil(job.startSeconds * 2) / 2; t < job.endSeconds; t += 0.5) times.push(t);
            return { beats: { bpm: 120, times } };
        },
    };
}

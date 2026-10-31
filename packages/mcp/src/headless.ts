// Headless mode: opens a project file in Node with LocalBackend, a vanilla store,
// and a TimelineController, for `opennan-studio mcp serve` and tests. With an ffmpeg,
// export.start and previewFrame run on @opennan/export's native runner, and the phase 11 local analysis decodes audio
// with it. ai.run jobs are recorded in one AiJobBook (check_generation_status); prices come from the registry.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExportRunner } from "@opennan/export";
import { AiJobBook, createAiRunner, type ProviderRegistry } from "@opennan/provider-sdk";
import { createNodeRunner } from "@opennan/export/node";
import {
    LOCAL_MEDIA_URL_PREFIX, LocalBackend, TimelineController, createEditorStore, type EditorStore, type FrameRenderer, type MediaAnalyzerHost,
} from "@opennan/timeline-core";
import { createStudioExporter, type StudioExporter } from "./export";
import { createHeadlessMediaImporter } from "./generated-media";
import { createFfmpegAnalyzer, createStorySheetMaker } from "./headless-media";
import { createLocalFileReader } from "./local-files";
import { blobPathFor, mediaDirFor, openFilePersistence, readProjectFile } from "./project-file";
import { createControllerSession, type StudioHost, type StudioSession } from "./session";

/** The variables the @opennan/export ffmpeg tests read too; `mcp serve` uses them when --ffmpeg is not given. */
export const FFMPEG_ENV = "OPENNAN_FFMPEG";
export const FFPROBE_ENV = "OPENNAN_FFPROBE";

export interface HeadlessOptions {
    projectFile: string;
    /** Edits stay in memory; the file is never written and not locked. */
    readOnly?: boolean;
    /** Folders besides the project folder that publish_*_to_timeline may read from. */
    allowDirs?: readonly string[];
    /** Native ffmpeg for assemble_video and preview frames. Without it (and without exportRunner) both are unavailable. */
    ffmpeg?: { ffmpegPath: string; ffprobePath: string };
    /** Where exports are written. Default: "<project folder>/exports". */
    exportDir?: string;
    /** A runner instead of the native ffmpeg one (tests, other hosts). */
    exportRunner?: ExportRunner;
    /** Overrides the exporter's frame renderer. */
    frameRenderer?: FrameRenderer;
    idFactory?: () => string;
    host?: StudioHost;
    /** AI providers for ai.run (mcp serve registers OpenNan with the signed-in account). Without them ai.run is unavailable. */
    providers?: ProviderRegistry;
    /** Plain-http media downloads from loopback (tests against the fake OpenNan server). */
    allowLoopbackDownloads?: boolean;
    /**
     * analysis.run (remove_silences, detect_beats). Default: ffmpeg decoding when an ffmpeg was given, else none
     * (those tools answer unavailable). null turns it off.
     */
    analyzer?: MediaAnalyzerHost | null;
}

export interface HeadlessStudio {
    projectId: string;
    projectFile: string;
    session: StudioSession;
    controller: TimelineController;
    store: EditorStore;
    backend: LocalBackend;
    /** Set when an ffmpeg or exportRunner was given. */
    exporter?: StudioExporter;
    /** Every ai.run job of this session (check_generation_status). */
    aiJobs: AiJobBook;
    /** Cancels a running export, waits for pending saves, stops the controller, and releases the writer lock. */
    close(): Promise<void>;
}

/** "film.opennan.json" -> "film": the export file name prefix. */
function exportBaseName(projectFile: string): string {
    const base = path.basename(projectFile).replace(/\.opennan\.json$|\.json$/i, "");
    return base.replace(/[^A-Za-z0-9._-]/g, "_") || "export";
}

export async function openHeadlessProject(options: HeadlessOptions): Promise<HeadlessStudio> {
    const projectFile = path.resolve(options.projectFile);
    const { project } = await readProjectFile(projectFile);
    const readFile = await createLocalFileReader({ baseDir: path.dirname(projectFile), allowDirs: options.allowDirs });
    const persistence = await openFilePersistence(projectFile, { readOnly: options.readOnly });
    const mediaDir = mediaDirFor(projectFile);
    // The export source policy resolves its media roots once, so the folder must exist before the first render.
    if (!options.readOnly) await fs.mkdir(mediaDir, { recursive: true });
    // No object URLs in Node: nothing renders media here, and they would pin every blob in memory.
    const backend = new LocalBackend({ persistence, idFactory: options.idFactory, createObjectUrl: () => "" });
    let runner = options.exportRunner;
    if (!runner && options.ffmpeg) {
        const exportDir = path.resolve(options.exportDir ?? path.join(path.dirname(projectFile), "exports"));
        await fs.mkdir(exportDir, { recursive: true });
        const base = exportBaseName(projectFile);
        runner = createNodeRunner({
            ffmpegPath: options.ffmpeg.ffmpegPath,
            ffprobePath: options.ffmpeg.ffprobePath,
            // Agent-triggered renders keep the fail-closed defaults: only this project's media folder, no network.
            mediaRoots: [mediaDir],
            resolveSource: (url) => (url.startsWith(LOCAL_MEDIA_URL_PREFIX) ? blobPathFor(mediaDir, url.slice(LOCAL_MEDIA_URL_PREFIX.length)) : url),
            outputPath: (container) => path.join(exportDir, `${base}-${Date.now()}.${container}`),
        });
    }
    const exporter = runner ? createStudioExporter({ runner, effects: () => backend.listEffects("effect") }) : undefined;
    const store = createEditorStore();
    const aiJobs = new AiJobBook();
    const analyzer = options.analyzer === undefined
        ? (options.ffmpeg ? createFfmpegAnalyzer({ mediaDir, ffmpegPath: options.ffmpeg.ffmpegPath }) : undefined)
        : options.analyzer ?? undefined;
    const controller = new TimelineController({
        backend, store, projectId: project.meta.id,
        frameRenderer: options.frameRenderer ?? exporter?.frameRenderer,
        onExport: exporter?.onExport,
        onExportCancel: exporter?.onExportCancel,
        ...(options.providers
            ? { onAiRun: createAiRunner(options.providers, { importMedia: createHeadlessMediaImporter(backend, { allowLoopback: options.allowLoopbackDownloads }), jobs: aiJobs }) }
            : {}),
        ...(analyzer ? { analyzer } : {}),
    });
    try {
        await controller.load();
    } catch (error) {
        controller.dispose();
        await persistence.close();
        throw error;
    }
    const storySheet = options.ffmpeg
        ? createStorySheetMaker({
            mediaDir, ffmpeg: options.ffmpeg,
            save: async (file, name) => {
                const media = await backend.uploadFile(project.meta.id, new File([file], name, { type: file.type }), "image");
                await backend.saveToLibrary(project.meta.id, media);
                return media.url;
            },
        })
        : undefined;
    const host: StudioHost = { readFile, ...(storySheet ? { storySheet } : {}), ...options.host };
    const session = createControllerSession({ controller, store, backend, host, exporter, aiJobs, ...(options.providers ? { providers: options.providers } : {}) });
    return {
        projectId: project.meta.id,
        projectFile,
        session,
        controller,
        store,
        backend,
        exporter,
        aiJobs,
        async close() {
            exporter?.cancel();
            await controller.flushPending();
            controller.dispose();
            await persistence.close();
        },
    };
}

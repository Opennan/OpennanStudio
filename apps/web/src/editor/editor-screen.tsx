// The editor: <TimelineProvider> over the shared LocalBackend, composed from the
// package's <Timeline>, <Preview>, and <ClipProperties> (spec §5.3) like apps/playground/src/app.tsx.
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
    AiJobTray, EditorLibrary, Inspector, Preview, Timeline, TimelineProvider, useEditorStore, useEditorStoreApi, useTimelineController, useTimelineMessages,
    type GenerateKind, type TimelineHandle,
} from "@opennan/timeline-react";
import type { AiTargetRef, EditorStore, TimelineController } from "@opennan/timeline-core";
import { useAccount } from "../account/account-context";
import { createEditorAi } from "../ai/editor-ai";
import { accountHold, notEnoughCreditsMessage } from "../ai/hold-check";
import { createFrameCapture } from "../ai/capture-frame";
import { createAiRunner } from "@opennan/provider-sdk";
import { AutoCaptionsDialog } from "../ai/auto-captions-dialog";
import { GenerateDialog } from "../ai/generate-dialog";
import { StoryFilmDialog } from "../ai/story-film-dialog";
import { createMediaImporter } from "../ai/import-generated";
import { ExportDialog } from "../export/export-dialog";
import { useLocalExport, type LocalExport } from "../export/use-local-export";
import { MediaBin } from "../media/media-bin";
import { useMediaLibrary, type MediaLibrary } from "../media/use-media-library";
import { useStudioRuntime } from "../platform/runtime-context";
import { ScreenMessage } from "../ui/screen-message";
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, loadLayout, saveLayout, type EditorLayout } from "./editor-layout";
import { RightDock, loadRightDockTab, saveRightDockTab, type RightDockTab } from "./right-dock";
import { AgentGuidance } from "../ai/agent-guidance";
import { EditorTopBar } from "./editor-topbar";
import { Splitter } from "./splitter";
import { useEditorShortcuts } from "./shortcuts/use-editor-shortcuts";
import { ToastList } from "./toast-list";
import { useToastQueue } from "./use-toast-queue";
import "./editor.css";

export function EditorRoute({ projectId }: { projectId: string }) {
    const { backend, retainProject, platform } = useStudioRuntime();
    const [state, setState] = useState<"checking" | "ready" | "missing" | "failed">("checking");
    // Leaving the editor closes the project (ProjectCatalog.closeProject, via the runtime's hold count).
    useEffect(() => retainProject(projectId), [retainProject, projectId]);
    useEffect(() => {
        let live = true;
        backend.hasProject(projectId).then((exists) => {
            if (live) setState(exists ? "ready" : "missing");
        }, () => {
            if (live) setState("failed");
        });
        return () => {
            live = false;
        };
    }, [backend, projectId]);
    if (state === "failed") return <ScreenMessage title="Can't open this project" message="It could not be read from this device's storage. Reload and try again." />;
    if (state === "checking") return <p className="screen-message muted">Opening project…</p>;
    if (state === "missing") {
        return <ScreenMessage title="Project not found" message={platform === "desktop" ? "It may have been deleted." : "It may have been deleted, or it was created in another browser."} />;
    }
    return <EditorScreen projectId={projectId} />;
}

/** What the editor AI host reaches inside <TimelineProvider> (the controller and store live there) and the dialogs it opens. */
interface EditorBridge {
    ai?: ReturnType<typeof createEditorAi>;
    controller?: TimelineController;
    store?: EditorStore;
    openGenerate?(kind: GenerateKind, options?: { fromFrame?: boolean }): void;
    openAutoCaptions?(target?: AiTargetRef): void;
    openStoryFilm?(): void;
}

function EditorScreen({ projectId }: { projectId: string }) {
    const { backend, media, markerStorage, exportPlatform, debug, ui, providers } = useStudioRuntime();
    const { account, openSignIn } = useAccount();
    const library = useMediaLibrary(projectId);
    const toasts = useToastQueue();
    const localExport = useLocalExport(exportPlatform, media);
    const [exporting, setExporting] = useState(false);
    // export.start (agents, MCP) opens the dialog and runs the same export as the button.
    const onExport = useMemo(
        () => localExport.exporter.commandHandler(backend, () => setExporting(true)),
        [localExport.exporter, backend],
    );
    // ai.run (UI, agents, MCP) runs on the runtime's providers (spec §5.4); generated media goes to the library.
    // Only the e2e build may download from its loopback fake OpenNan server.
    const onAiRun = useMemo(() => createAiRunner(providers, { importMedia: createMediaImporter(backend, { allowLoopback: import.meta.env.MODE === "e2e" }) }), [providers, backend]);
    // AI in the editor (phase 11): prices, the sign-in gate, the job queue, Retry toasts.
    const bridge = useRef<EditorBridge>({});
    const pushToast = toasts.push;
    const ai = useMemo(() => createEditorAi({
        controller: {
            execute: (command, options) => bridge.current.controller
                ? bridge.current.controller.execute(command, options)
                : Promise.resolve({ ok: false, changed: {}, error: "The editor is still loading." }),
            snapshot: () => bridge.current.controller!.snapshot(),
        },
        providers,
        isSignedIn: () => account.status().state === "signed-in",
        openSignIn: (feature) => openSignIn({ reason: feature }),
        toast: (toast) => void pushToast(toast),
        activity: (itemId, progress) => {
            const state = bridge.current.store?.getState() as { setAiActivity?(id: string, value: { progress?: number } | null): void } | undefined;
            state?.setAiActivity?.(itemId, progress === null ? null : { progress });
        },
        refreshAccount: () => void account.refresh(),
        account: accountHold(account),
        notEnoughCredits: (hold) => void pushToast({ kind: "error", message: notEnoughCreditsMessage(hold), action: { label: "Buy credits", run: () => account.openConsole("billing") } }),
        openGenerate: (kind, options) => bridge.current.openGenerate?.(kind, options),
        openAutoCaptions: (target) => bridge.current.openAutoCaptions?.(target),
        openStoryFilm: () => bridge.current.openStoryFilm?.(),
    }), [providers, account, openSignIn, pushToast]);
    bridge.current.ai = ai;
    useEffect(() => () => ai.dispose(), [ai]);
    return (
        <TimelineProvider
            backend={backend}
            projectId={projectId}
            media={media}
            markerStorage={markerStorage}
            debugHooks={debug}
            onToast={toasts.push}
            onDismissToast={toasts.dismiss}
            onSaveToSources={(uploaded) => void library.add(uploaded)}
            onExport={onExport}
            onAiRun={onAiRun}
            ai={ai}
        >
            <EditorWorkspace library={library} exporting={exporting} setExporting={setExporting} localExport={localExport} bridge={bridge} projectId={projectId} />
            {ui.EditorAddons && <ui.EditorAddons projectId={projectId} />}
            <div className="editor-ai-jobs"><AiJobTray /></div>
            <ToastList toasts={toasts.toasts} onDismiss={toasts.dismiss} />
        </TimelineProvider>
    );
}

function EditorWorkspace({ library, exporting, setExporting, localExport, bridge, projectId }: {
    projectId: string;
    library: MediaLibrary;
    exporting: boolean;
    setExporting(open: boolean): void;
    localExport: LocalExport;
    bridge: MutableRefObject<EditorBridge>;
}) {
    const timeline = useRef<TimelineHandle>(null);
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    const [captioning, setCaptioning] = useState<false | { target?: AiTargetRef }>(false);
    const [generating, setGenerating] = useState<{ kind: GenerateKind; fromFrame?: boolean } | null>(null);
    const [filming, setFilming] = useState(false);
    bridge.current.controller = controller;
    bridge.current.store = store;
    bridge.current.openGenerate = (kind, options) => setGenerating({ kind, ...(options?.fromFrame ? { fromFrame: true } : {}) });
    bridge.current.openAutoCaptions = (target) => setCaptioning(target ? { target } : {});
    bridge.current.openStoryFilm = () => setFilming(true);
    // A dialog owns the keyboard: the editor keymap and the timeline's own listeners are both off.
    const pastingAttributes = useEditorStore((s) => s.attributePastePicker !== null);
    const dialogOpen = exporting || captioning !== false || generating !== null || filming || pastingAttributes;
    useEditorShortcuts(timeline, { enabled: !dialogOpen });
    const { debug, providers, backend, media, ui } = useStudioRuntime();
    const [dockTab, setDockTab] = useState<RightDockTab>(loadRightDockTab);
    const chooseDockTab = (tab: RightDockTab) => { setDockTab(tab); saveRightDockTab(tab); };
    const projectName = controller.snapshot().project?.name ?? "Project";
    const captureFrame = useMemo(() => createFrameCapture({
        snapshot: () => controller.snapshot(), backend, projectId, resolveMediaUrl: (url) => media.resolveMediaUrl(url),
    }), [controller, backend, projectId, media]);
    const t = useTimelineMessages("studioEditor");
    useEffect(() => {
        // providers: e2e screenshots register a stand-in transcriber to show the auto-captions styles.
        if (debug) Object.assign(window, { __studio: { controller, store, timeline, providers, ai: bridge.current.ai } });
    }, [controller, store, debug, providers]);
    const [layout, setLayout] = useState<EditorLayout>(loadLayout);
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const resize = (key: keyof EditorLayout) => (next: number) => setLayout((current) => ({ ...current, [key]: next }));
    const commit = () => saveLayout(layoutRef.current);
    const reset = (key: keyof EditorLayout) => () => {
        const next = { ...layoutRef.current, [key]: DEFAULT_LAYOUT[key] };
        setLayout(next);
        saveLayout(next);
    };
    const style = { "--editor-library-w": `${layout.library}px`, "--editor-inspector-w": `${layout.inspector}px`, "--editor-timeline-h": `${layout.timeline}px` } as React.CSSProperties;
    return (
        <div className="editor" style={style}>
            <EditorTopBar
                onExport={() => setExporting(true)} onAutoCaptions={() => setCaptioning({})} onGenerate={() => setGenerating({ kind: "image" })}
                aiOpen={dockTab === "ai"} onToggleAi={() => chooseDockTab(dockTab === "ai" ? "inspector" : "ai")}
            />
            <aside className="editor-library" aria-label={t("libraryLabel")}>
                <EditorLibrary media={<MediaBin library={library} kind="visual" />} audio={<MediaBin library={library} kind="audio" />} />
            </aside>
            <Splitter
                className="editor-split-library" orientation="vertical" label={t("resizeLibrary")} direction={1}
                value={layout.library} min={LAYOUT_LIMITS.library[0]} max={LAYOUT_LIMITS.library[1]}
                onResize={resize("library")} onCommit={commit} onReset={reset("library")}
            />
            <section className="editor-preview" aria-label="Preview"><Preview /></section>
            <Splitter
                className="editor-split-inspector" orientation="vertical" label={t("resizeInspector")} direction={-1}
                value={layout.inspector} min={LAYOUT_LIMITS.inspector[0]} max={LAYOUT_LIMITS.inspector[1]}
                onResize={resize("inspector")} onCommit={commit} onReset={reset("inspector")}
            />
            <aside className="editor-inspector" aria-label="Properties">
                <RightDock tab={dockTab} onTab={chooseDockTab} enabled={!dialogOpen} inspector={<Inspector />}
                    ai={ui.AiPanel ? <ui.AiPanel key={projectId} projectId={projectId} projectName={projectName} /> : <AgentGuidance />} />
            </aside>
            <Splitter
                className="editor-split-timeline" orientation="horizontal" label={t("resizeTimeline")} direction={-1}
                value={layout.timeline} min={LAYOUT_LIMITS.timeline[0]} max={LAYOUT_LIMITS.timeline[1]}
                onResize={resize("timeline")} onCommit={commit} onReset={reset("timeline")}
            />
            <section className="editor-timeline" aria-label="Timeline"><Timeline ref={timeline} className="timeline-host" shortcutsEnabled={!dialogOpen} /></section>
            {exporting && <ExportDialog onClose={() => setExporting(false)} local={localExport} />}
            {captioning && <AutoCaptionsDialog target={captioning.target} onClose={() => setCaptioning(false)} />}
            {generating && <GenerateDialog initialKind={generating.kind} fromFrame={generating.fromFrame} captureFrame={captureFrame} onClose={() => setGenerating(null)} />}
            {filming && <StoryFilmDialog projectId={projectId} onClose={() => setFilming(false)} />}
        </div>
    );
}

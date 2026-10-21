// The editor: <TimelineProvider> over the shared LocalBackend, composed from the
// package's <Timeline>, <Preview>, and <ClipProperties> (spec §5.3) like apps/playground/src/app.tsx.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { ProjectLock } from "../cloud/tab-lock";
import {
    AiJobTray, EditorLibrary, Inspector, Preview, Timeline, TimelineProvider, useEditorStore, useEditorStoreApi, useTimelineController, useTimelineMessages,
    type GenerateKind, type TimelineHandle,
} from "@opennan/timeline-react";
import type { AiTargetRef, EditorStore, TimelineController } from "@opennan/timeline-core";
import { useAccount, useAccountStatus } from "../account/account-context";
import { isCloudProjectId } from "@opennan/cloud-backend";
import { shotsEditUrl } from "../cloud/cloud-copy";
import { createEditorAi } from "../ai/editor-ai";
import { accountHold, notEnoughCreditsMessage } from "../ai/hold-check";
import { createFrameCapture } from "../ai/capture-frame";
import { createAiRunner } from "@opennan/provider-sdk";
import { AutoCaptionsDialog } from "../ai/auto-captions-dialog";
import { GenerateDialog } from "../ai/generate-dialog";
import { createMediaImporter } from "../ai/import-generated";
import { ExportDialog } from "../export/export-dialog";
import { useLocalExport, type LocalExport } from "../export/use-local-export";
import { MediaBin } from "../media/media-bin";
import { useMediaLibrary, type MediaLibrary } from "../media/use-media-library";
import { useStudioRuntime } from "../platform/runtime-context";
import { ScreenMessage } from "../ui/screen-message";
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, loadLayout, saveLayout, type EditorLayout } from "./editor-layout";
import { EditorTopBar } from "./editor-topbar";
import { Splitter } from "./splitter";
import { useEditorShortcuts } from "./shortcuts/use-editor-shortcuts";
import { RightDock, loadRightDockTab, saveRightDockTab, type RightDockTab } from "./right-dock";
import { DirectorPanel } from "../ai/director-panel";
import { useDirectorHost } from "../ai/use-director";
import { useCloudBackend } from "../cloud/use-cloud";
import { ShareDialog } from "../share/share-dialog";
import { useShareHost } from "../share/use-share";
import type { TimelineToast } from "@opennan/timeline-core";
import { ToastList } from "./toast-list";
import { useToastQueue } from "./use-toast-queue";
import "./editor.css";

export function EditorRoute({ projectId }: { projectId: string }) {
    const { backend, retainProject, platform } = useStudioRuntime();
    const { account, openSignIn } = useAccount();
    const status = useAccountStatus(account);
    const cloudProject = isCloudProjectId(projectId);
    const signedIn = status.state === "signed-in";
    const [state, setState] = useState<"checking" | "ready" | "missing" | "failed">("checking");
    const { cloud } = useStudioRuntime();
    const [lock, setLock] = useState<ProjectLock | null>(null);
    useEffect(() => {
        if (!cloudProject || !signedIn || !cloud?.locks) return;
        const handle = cloud.locks.acquire(projectId);
        setLock(handle.lock);
        return () => handle.release();
    }, [cloud, projectId, cloudProject, signedIn]);
    const lockState = useSyncExternalStore(
        (listener) => lock?.subscribe(listener) ?? (() => undefined),
        () => (cloud?.locks ? lock?.state() ?? "waiting" : "held"),
    );
    // Leaving the editor closes the project (ProjectCatalog.closeProject, via the runtime's hold count).
    useEffect(() => retainProject(projectId), [retainProject, projectId]);
    useEffect(() => {
        if (cloudProject && !signedIn) return;
        let live = true;
        backend.hasProject(projectId).then((exists) => {
            if (live) setState(exists ? "ready" : "missing");
        }, () => {
            if (live) setState("failed");
        });
        return () => {
            live = false;
        };
    }, [backend, projectId, cloudProject, signedIn]);
    if (cloudProject && !signedIn) {
        if (status.state === "restoring") return <p className="screen-message muted">Opening project…</p>;
        return (
            <div className="screen-message" data-testid="cloud-editor-signin">
                <h1>Sign in to open this cloud project</h1>
                <p className="muted">OpenNan cloud projects open on any device signed in to the same account.</p>
                <button type="button" className="button primary" onClick={() => void openSignIn({ reason: "Open this cloud project" })}>Sign in with OpenNan</button>
            </div>
        );
    }
    if (cloudProject && lockState !== "held") {
        if (lockState === "waiting") return <p className="screen-message muted">Opening project…</p>;
        return (
            <div className="screen-message" data-testid="cloud-editor-locked">
                <h1>{lockState === "lost" ? "This cloud project was opened in another tab" : "This cloud project is open in another tab"}</h1>
                <p className="muted">One tab at a time edits a cloud project, so their edits never overwrite each other on this device.</p>
                <button type="button" className="button primary" onClick={() => lock?.takeOver()}>Open it here</button>
            </div>
        );
    }
    if (state === "failed") return <ScreenMessage title="Can't open this cloud project" message="OpenNan can't be reached and this project is not on this device yet. Try again when you're online." />;
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
    }), [providers, account, openSignIn, pushToast]);
    bridge.current.ai = ai;
    useEffect(() => () => ai.dispose(), [ai]);
    // Cloud projects: "edited elsewhere" after an undo, and other sync notices, as toasts.
    const { cloud } = useStudioRuntime();
    useEffect(() => {
        if (!isCloudProjectId(projectId)) return;
        return cloud?.backend()?.onNotice((message, id) => {
            if (id === projectId) void pushToast({ kind: "info", message });
        });
    }, [cloud, projectId, pushToast]);
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
            <EditorWorkspace library={library} exporting={exporting} setExporting={setExporting} localExport={localExport} bridge={bridge} projectId={projectId} toast={pushToast} />
            {ui.EditorAddons && <ui.EditorAddons projectId={projectId} />}
            <div className="editor-ai-jobs"><AiJobTray /></div>
            <ToastList toasts={toasts.toasts} onDismiss={toasts.dismiss} />
        </TimelineProvider>
    );
}

function EditorWorkspace({ library, exporting, setExporting, localExport, bridge, projectId, toast }: {
    projectId: string;
    toast(toast: TimelineToast): void;
    library: MediaLibrary;
    exporting: boolean;
    setExporting(open: boolean): void;
    localExport: LocalExport;
    bridge: MutableRefObject<EditorBridge>;
}) {
    const timeline = useRef<TimelineHandle>(null);
    const { account } = useStudioRuntime();
    const shotsUrl = shotsEditUrl(account.consoleOrigin, projectId);
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    const [captioning, setCaptioning] = useState<false | { target?: AiTargetRef }>(false);
    const [generating, setGenerating] = useState<{ kind: GenerateKind; fromFrame?: boolean } | null>(null);
    bridge.current.controller = controller;
    bridge.current.store = store;
    bridge.current.openGenerate = (kind, options) => setGenerating({ kind, ...(options?.fromFrame ? { fromFrame: true } : {}) });
    bridge.current.openAutoCaptions = (target) => setCaptioning(target ? { target } : {});
    // A dialog owns the keyboard: the editor keymap and the timeline's own listeners are both off.
    const pastingAttributes = useEditorStore((s) => s.attributePastePicker !== null);
    const [sharing, setSharing] = useState(false);
    const dialogOpen = exporting || captioning !== false || generating !== null || pastingAttributes || sharing;
    useEditorShortcuts(timeline, { enabled: !dialogOpen });
    const { debug, providers, backend, media } = useStudioRuntime();
    const captureFrame = useMemo(() => createFrameCapture({
        snapshot: () => controller.snapshot(), backend, projectId, resolveMediaUrl: (url) => media.resolveMediaUrl(url),
    }), [controller, backend, projectId, media]);
    const t = useTimelineMessages("studioEditor");
    // The right dock: Inspector | AI (phase 9b). The AI director needs the cloud backend the router already built.
    const cloudBackend = useCloudBackend(false);
    const director = useDirectorHost(projectId, isCloudProjectId(projectId) ? cloudBackend : null, toast);
    const [dockTab, setDockTab] = useState<RightDockTab>(loadRightDockTab);
    const chooseDockTab = useCallback((next: RightDockTab) => {
        setDockTab(next);
        saveRightDockTab(next);
    }, []);
    const projectName = useEditorStore((s) => s.projectMeta?.name ?? "");
    const shareHost = useShareHost({ projectId, projectName, open: sharing, cloudBackend: isCloudProjectId(projectId) ? cloudBackend : null, localExport, controller, backend });
    useEffect(() => {
        // providers: e2e screenshots register a stand-in transcriber to show the auto-captions styles.
        if (debug) Object.assign(window, { __studio: { controller, store, timeline, providers, ai: bridge.current.ai, director } });
    }, [controller, store, debug, providers, director]);
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
                onShare={() => setSharing(true)}
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
                <RightDock
                    tab={dockTab} onTab={chooseDockTab} enabled={!dialogOpen}
                    inspector={<Inspector shotsEditUrl={shotsUrl} />}
                    ai={<DirectorPanel projectId={projectId} projectName={projectName} host={director} />}
                />
            </aside>
            <Splitter
                className="editor-split-timeline" orientation="horizontal" label={t("resizeTimeline")} direction={-1}
                value={layout.timeline} min={LAYOUT_LIMITS.timeline[0]} max={LAYOUT_LIMITS.timeline[1]}
                onResize={resize("timeline")} onCommit={commit} onReset={reset("timeline")}
            />
            <section className="editor-timeline" aria-label="Timeline"><Timeline ref={timeline} className="timeline-host" shortcutsEnabled={!dialogOpen} /></section>
            {exporting && <ExportDialog onClose={() => setExporting(false)} local={localExport} />}
            {captioning && <AutoCaptionsDialog target={captioning.target} onClose={() => setCaptioning(false)} />}
            {sharing && <ShareDialog projectId={projectId} projectName={projectName} host={shareHost} onClose={() => setSharing(false)} />}
            {generating && <GenerateDialog initialKind={generating.kind} fromFrame={generating.fromFrame} captureFrame={captureFrame} onClose={() => setGenerating(null)} />}
        </div>
    );
}

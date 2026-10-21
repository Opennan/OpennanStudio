// Desktop pieces inside the editor (StudioUi.EditorAddons, rendered inside <TimelineProvider>): serves the
// open project to the MCP server, asks the person before an agent's public share link (9c.1), shows refused media,
// and hosts the terminal drawer.
import { useEffect, useRef, useState } from "react";
import { useEditorStoreApi, useTimelineBackend, useTimelineController, useTimelineToast } from "@opennan/timeline-react";
import { shareSiteOf, syncLabel, useStudioRuntime } from "@opennan/web/studio";
import { AgentShareDialog, createShareQuestions } from "./agent-share-dialog";
import { MediaBanner } from "./media-banner";
import { startSessionResponder } from "./session-responder";
import { TerminalDock } from "./terminal-panel";

export function EditorAddons({ projectId }: { projectId: string }) {
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    const { backend } = useTimelineBackend();
    const runtime = useStudioRuntime();
    // Read through a ref: the responder stays attached when the toast API's identity changes.
    const toastApi = useTimelineToast();
    const toast = useRef(toastApi);
    toast.current = toastApi;
    const [questions] = useState(createShareQuestions);
    useEffect(() => {
        let detach: (() => Promise<void>) | null = null;
        let live = true;
        const cloud = runtime.cloud ? { backend: () => runtime.cloud!.backend(), local: runtime.cloud.local, syncLabel } : undefined;
        const openProject = (id: string) => {
            window.location.hash = `#/p/${encodeURIComponent(id)}`;
        };
        void startSessionResponder({ bridge: window.opennan, projectId, controller, store, backend, ...(cloud ? { cloud } : {}), openProject,
            shareSite: () => ({ ...shareSiteOf(runtime.account.status()), ...(runtime.cloud?.loopbackShares ? { allowLoopback: true } : {}) }), notify: (message) => void toast.current.info(message), confirmShare: (question) => questions.ask(question),
        }).then((stop) => {
            if (live) detach = stop;
            else void stop();
        });
        return () => {
            live = false;
            // A question this session asked is never answered by a later one's dialog.
            questions.closeAll();
            void detach?.();
        };
    }, [projectId, controller, store, backend, runtime, questions]);
    return (
        <>
            <AgentShareDialog questions={questions} />
            <MediaBanner />
            <TerminalDock bridge={window.opennan} projectId={projectId} />
        </>
    );
}

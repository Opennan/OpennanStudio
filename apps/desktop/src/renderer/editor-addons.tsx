// Desktop pieces inside the editor (StudioUi.EditorAddons, rendered inside <TimelineProvider>): serves the
// open project to the MCP server, shows refused media, and hosts the terminal drawer.
import { useEffect } from "react";
import { useEditorStoreApi, useTimelineBackend, useTimelineController } from "@opennan/timeline-react";
import { MediaBanner } from "./media-banner";
import { startSessionResponder } from "./session-responder";
import { TerminalDock } from "./terminal-panel";

export function EditorAddons({ projectId }: { projectId: string }) {
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    const { backend } = useTimelineBackend();
    useEffect(() => {
        let detach: (() => Promise<void>) | null = null;
        let live = true;
        void startSessionResponder({ bridge: window.opennan, projectId, controller, store, backend }).then((stop) => {
            if (live) detach = stop;
            else void stop();
        });
        return () => {
            live = false;
            void detach?.();
        };
    }, [projectId, controller, store, backend]);
    return (
        <>
            <MediaBanner />
            <TerminalDock bridge={window.opennan} projectId={projectId} />
        </>
    );
}

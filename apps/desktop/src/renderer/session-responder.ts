// Answers main's session requests with the open editor's controller, store, and backend, so MCP tools run on
// the same controller (and undo history) as the person (spec §5.1.1, §7.2). The UI-state mapping mirrors
// @opennan/mcp's createControllerSession (typed by its StudioUiState); importing that module here would put
// the MCP SDK and Ajv into the renderer bundle.
import type { StudioUiState } from "@opennan/mcp/server";
import type { EditorCommand, EditorStore, TimelineBackend, TimelineController, UploadedMedia } from "@opennan/timeline-core";
import type { DesktopBridge } from "../shared/bridge";

export interface SessionResponderOptions {
    bridge: Pick<DesktopBridge, "session">;
    projectId: string;
    controller: TimelineController;
    store: EditorStore;
    backend: TimelineBackend;
}

export function uiStateOf(store: EditorStore): StudioUiState {
    const s = store.getState();
    return {
        currentTime: s.currentTime,
        isPlaying: s.isPlaying,
        shuttleSpeed: s.shuttleSpeed,
        zoom: s.timelineZoom,
        toolMode: s.toolMode,
        snapEnabled: s.snapEnabled,
        selection: {
            clipIds: [...s.selectedClipIds],
            sceneId: s.selectedSceneId,
            transition: s.selectedTransition,
            audioTarget: s.selectedAudioTarget,
            markerId: s.selectedMarkerId,
        },
        markers: s.timelineMarkers.map((marker) => ({ ...marker })),
        canUndo: s.canUndo,
        canRedo: s.canRedo,
        activePanel: null,
    };
}

/** Plain data for IPC (structured clone): drops anything a snapshot might carry that is not JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createSessionResponder({ projectId, controller, store, backend }: Omit<SessionResponderOptions, "bridge">) {
    // Agent ai.run commands in flight: main's "cancelAiRun" (a cancelled or timed-out MCP call) aborts them.
    const agentRuns = new Set<AbortController>();
    return async (method: string, args: unknown[]): Promise<unknown> => {
        switch (method) {
            case "execute": {
                const command = args[0] as EditorCommand;
                if (command?.type !== "ai.run") return plain(await controller.execute(command));
                const abort = new AbortController();
                agentRuns.add(abort);
                try {
                    return plain(await controller.execute(command, { signal: abort.signal }));
                } finally {
                    agentRuns.delete(abort);
                }
            }
            case "cancelAiRun":
                for (const abort of agentRuns) abort.abort();
                return undefined;
            case "snapshot":
                return plain(controller.snapshot());
            case "describeTimeline":
                return controller.describeTimeline();
            case "uiState":
                return plain(uiStateOf(store));
            case "historyDepth":
                return controller.historyDepth();
            case "listEffects":
                return backend.listEffects ? plain(await backend.listEffects(args[0] === "transition" ? "transition" : "effect")) : [];
            case "saveToLibrary":
                await backend.saveToLibrary?.(projectId, args[0] as UploadedMedia);
                return undefined;
            default:
                throw new Error(`Unknown session method: ${method}`);
        }
    };
}

/** Serves the editor to main's MCP host until the returned function runs. */
export async function startSessionResponder(options: SessionResponderOptions): Promise<() => Promise<void>> {
    return options.bridge.session.attach(options.projectId, createSessionResponder(options));
}

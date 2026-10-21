// The AI director host of the open cloud project (one per editor), built inside <TimelineProvider> where the
// controller and the store live. Null on a local project, signed out, or before the cloud backend exists.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isCloudProjectId, type OpenNanCloudBackend } from "@opennan/cloud-backend";
import { useEditorStoreApi, useTimelineController, useTimelineMessages } from "@opennan/timeline-react";
import { useAccount } from "../account/account-context";
import { DirectorHost, type DirectorState } from "./director-host";
import { accountHold } from "./hold-check";
import { formatUsdUp } from "@opennan/director-client";
import { directorErrorText, type DirectorT } from "./director-copy";
import type { TimelineToast } from "@opennan/timeline-core";

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

export function useDirectorHost(projectId: string, backend: OpenNanCloudBackend | null, toast: (toast: TimelineToast) => void): DirectorHost | null {
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    const { account, openSignIn } = useAccount();
    const t = useTimelineMessages("aiDirector");
    const host = useMemo(() => {
        if (!backend || !isCloudProjectId(projectId)) return null;
        return new DirectorHost({
            api: backend.api, backend, projectId, serverId: backend.serverId(projectId), controller,
            selection: () => {
                const s = store.getState();
                const scenes = [...s.selectedSceneIds, ...(s.selectedSceneId ? [s.selectedSceneId] : [])];
                const clips = [...s.selectedClipIds].filter((id) => !id.startsWith("temp-"));
                return { ...(scenes.length ? { sceneIds: [...new Set(scenes)] } : {}), ...(clips.length ? { clipIds: clips } : {}), timeSeconds: s.currentTime };
            },
            highlight: (ids, on) => {
                const state = store.getState();
                for (const id of [...ids.scenes, ...ids.clips]) {
                    const current = state.aiActivity[id];
                    // A job still running on the item keeps its progress line.
                    if (on && current?.progress === undefined) state.setAiActivity(id, { changed: true });
                    else if (current?.changed) state.setAiActivity(id, null);
                }
            },
            account: accountHold(account),
            notEnoughCredits: (hold, what) => toast({
                kind: "error", message: hold > 0 ? t(what === "message" ? "notEnoughMessage" : "notEnoughStep", { usd: formatUsdUp(hold) }) : t("errInsufficient"),
                action: { label: t("buyCredits"), run: () => account.openConsole("billing") },
            }),
            failed: (task, retry) => toast({
                kind: "error", message: `${task.label}: ${task.error ? directorErrorText(t as DirectorT, task.error) : t("taskFailed")}`,
                action: { label: t("retry"), run: retry },
            }),
            isSignedIn: () => account.status().state === "signed-in",
            openSignIn: () => openSignIn({ reason: t("title") }),
            storage: safeStorage(),
        });
        // t and toast are stable enough for the host's lifetime (messages and the toast queue do not change mid-edit).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backend, projectId, controller, store, account, openSignIn]);
    useEffect(() => {
        if (!host) return;
        void host.open();
        return () => host.dispose();
    }, [host]);
    return host;
}

const EMPTY: DirectorState = {
    turns: [], loading: false, hasMore: false, running: false, quote: null, quoteLoaded: false, budgetUsd: 0, busyElsewhere: null, error: null, tasks: [],
};

export function useDirectorState(host: DirectorHost | null): DirectorState {
    return useSyncExternalStore(
        (listener) => host?.subscribe(listener) ?? (() => undefined),
        () => host?.snapshot() ?? EMPTY,
    );
}

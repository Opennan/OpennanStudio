// The Share dialog's host for the open project (phase 9c), built when the dialog opens on a cloud project: the cloud
// backend's API client and final video, the account's share_base_url (where share pages live), the editor's own
// exporter for Export and share, the host's upload of an export, and the clipboard.
import { useEffect, useMemo } from "react";
import { isCloudProjectId, type OpenNanCloudBackend, type ShareSite } from "@opennan/cloud-backend";
import type { SessionStatus } from "@opennan/provider-opennan";
import type { TimelineBackend, TimelineController } from "@opennan/timeline-core";
import { useAccount } from "../account/account-context";
import { useStudioRuntime } from "../platform/runtime-context";
import type { LocalExport } from "../export/use-local-export";
import { exportForShare } from "./share-export";
import { ShareHost } from "./share-host";

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/** The clipboard (a click started it); an old browser without the async clipboard copies from a hidden field. */
export async function writeClipboard(text: string): Promise<void> {
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return;
    }
    const focused = document.activeElement as HTMLElement | null;
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    focused?.focus();
    if (!ok) throw new Error("The clipboard refused.");
}

/** Where this account's share pages live: GET /v1/account's share_base_url (null on older servers or signed out). */
export function shareSiteOf(status: SessionStatus): ShareSite {
    return { shareBaseUrl: status.state === "signed-in" ? status.account?.shareBaseUrl ?? null : null };
}

export function useShareHost(options: {
    projectId: string;
    projectName: string;
    open: boolean;
    cloudBackend: OpenNanCloudBackend | null;
    localExport: LocalExport;
    controller: TimelineController;
    backend: TimelineBackend;
}): ShareHost | null {
    const { projectId, open, cloudBackend, localExport, controller, backend } = options;
    const { account, cloud } = useStudioRuntime();
    const { openSignIn } = useAccount();
    const nameRef = options.projectName;
    const host = useMemo(() => {
        if (!open || !isCloudProjectId(projectId) || !cloudBackend) return null;
        const exporter = localExport.exporter;
        const upload = cloud?.uploadExport;
        return new ShareHost({
            api: cloudBackend.api, serverId: cloudBackend.serverId(projectId), site: { ...shareSiteOf(account.status()), ...(cloud?.loopbackShares ? { allowLoopback: true } : {}) },
            storage: safeStorage(), clipboard: writeClipboard,
            isSignedIn: () => account.status().state === "signed-in",
            openSignIn: () => openSignIn({ reason: "Share a view-only link" }),
            ...(upload ? {
                exportVideo: (run: { signal: AbortSignal; onProgress(ratio: number): void }) => exportForShare({
                    session: exporter.session, start: ({ resolution }) => exporter.start({ controller, backend, resolution }),
                }, run),
                uploadExport: (result, serverId, run) => upload(result, serverId, { ...run, name: nameRef }),
                setFinalVideo: (url: string) => cloudBackend.setFinalVideo(projectId, url),
                // The export dialog must never deliver (download) the share export later.
                exportFinished: () => {
                    if (exporter.session.getState().status !== "running") exporter.session.reset();
                },
            } : {}),
        });
        // The project name only names the uploaded file; a rename while the dialog is open is not worth a new host.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, projectId, cloudBackend, localExport.exporter, controller, backend, cloud, account, openSignIn]);
    useEffect(() => () => host?.dispose(), [host]);
    return host;
}

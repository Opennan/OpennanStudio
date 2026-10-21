// Cloud project channels (phase 9a): every call is sender-checked and schema-validated by handle(). API calls,
// uploads, downloads and copies answer {ok: true, value} or {ok: false, error: CloudApiError JSON}, because Electron
// passes only an Error's message across IPC and the sync engine needs the status, code and details. No answer
// carries the key: main adds it to the requests it sends and nothing it answers contains it.
import type { CloudResult } from "../../shared/bridge";
import { IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import { CloudApiError } from "@opennan/cloud-backend";
import { exportFile, NOT_AN_EXPORT } from "../export/export-ipc";
import { asCloudError, type CloudHost } from "./cloud-host";
import { registerCloudStreamIpc } from "./cloud-streams";

async function result<T>(run: () => Promise<T>): Promise<CloudResult<T>> {
    try {
        return { ok: true, value: await run() };
    } catch (error) {
        return { ok: false, error: asCloudError(error).toJSON() };
    }
}

/** Registers the cloud channels; the answer aborts every running stream (app shutdown). */
export function registerCloudIpc(ipc: IpcMainLike, { host, exportsDir }: { host: CloudHost; exportsDir?: string }): () => void {
    handle(ipc, IPC.cloudRequest, ({ method, path, body, query, headers }) => result(() => host.request(method, path, {
        ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), ...(headers ? { headers } : {}),
    })));
    handle(ipc, IPC.cloudDescribe, ({ mediaId }) => host.describe(mediaId));
    handle(ipc, IPC.cloudUpload, ({ mediaId, serverProjectId }) => result(() => host.upload(mediaId, serverProjectId)));
    // Export and share (phase 9c): only a file inside main's own exports folder (its real path), never any other file.
    handle(ipc, IPC.cloudUploadExport, ({ path: file, serverProjectId }) => result(async () => {
        let checked: string;
        try {
            if (!exportsDir) throw new Error(NOT_AN_EXPORT);
            checked = exportFile(exportsDir, file);
        } catch {
            throw new CloudApiError(400, "not_an_export", "Studio only shares a video it exported.");
        }
        return host.uploadExport(checked, serverProjectId);
    }));
    handle(ipc, IPC.cloudCache, ({ url, sizeBytes }) => result(async () => ({ url: await host.cache(url, sizeBytes) })));
    handle(ipc, IPC.cloudDuplicate, ({ mediaId, projectId }) => result(() => host.duplicate(mediaId, projectId)));
    handle(ipc, IPC.cloudStoreGet, ({ account, namespace, key }) => host.store.get(account, namespace, key));
    handle(ipc, IPC.cloudStorePut, ({ account, namespace, key, value }) => host.store.put(account, namespace, key, value));
    handle(ipc, IPC.cloudStoreDelete, ({ account, namespace, key }) => host.store.delete(account, namespace, key));
    handle(ipc, IPC.cloudStoreKeys, ({ account, namespace }) => host.store.keys(account, namespace));
    // The media cache (phase 9a.1): pins replace the set open cloud projects use; Settings reads and trims the cache.
    handle(ipc, IPC.cloudCachePin, ({ ids }) => void host.pin(ids));
    handle(ipc, IPC.cloudCacheUsage, () => result(() => host.usage()));
    handle(ipc, IPC.cloudCacheSetLimit, ({ bytes }) => result(() => host.setLimit(bytes)));
    handle(ipc, IPC.cloudCacheClear, () => result(() => host.clear()));
    // A director turn's events (phase 9b): bytes to the requesting window over events (cloud-streams.ts).
    return registerCloudStreamIpc(ipc, { host });
}

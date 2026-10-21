import { useCallback, useEffect, useState } from "react";
import type { UploadedMedia } from "@opennan/timeline-core";
import { LIBRARY_CHANGED_EVENT } from "../ai/import-generated";
import { useStudioRuntime } from "../platform/runtime-context";
import type { PersistState } from "../platform/storage";
import { completeMediaDuration, importMediaFiles, type ImportResult } from "./import-media";
import { probeMediaFile } from "./probe-media";

export interface MediaLibrary {
    items: UploadedMedia[] | null;
    busy: boolean;
    /** Also asks for persistent storage once (Task 8) and reports the answer. */
    importFiles(files: File[]): Promise<ImportResult & { persist: PersistState }>;
    add(media: UploadedMedia): Promise<void>;
    remove(url: string): Promise<void>;
}

export function useMediaLibrary(projectId: string): MediaLibrary {
    const { backend, storage, maxMediaBytes } = useStudioRuntime();
    const [items, setItems] = useState<UploadedMedia[] | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        setItems(await backend.listLibrary(projectId));
    }, [backend, projectId]);

    useEffect(() => {
        void refresh();
        // Generated media (the Generate dialog, agents' generation tools) lands in the library outside this hook.
        const onChange = (event: Event) => {
            if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === projectId) void refresh();
        };
        window.addEventListener(LIBRARY_CHANGED_EVENT, onChange);
        return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, onChange);
    }, [refresh, projectId]);

    const importFiles = useCallback(async (files: File[]) => {
        setBusy(true);
        try {
            const persist = await storage.ensurePersisted();
            const result = await importMediaFiles(backend, projectId, files, probeMediaFile, { estimate: storage.estimate, maxBytes: maxMediaBytes });
            return { ...result, persist };
        } finally {
            await refresh();
            setBusy(false);
        }
    }, [backend, projectId, refresh, storage, maxMediaBytes]);

    const add = useCallback(async (media: UploadedMedia) => {
        await backend.saveToLibrary(projectId, await completeMediaDuration(backend, media, probeMediaFile));
        await refresh();
    }, [backend, projectId, refresh]);

    const remove = useCallback(async (url: string) => {
        await backend.removeFromLibrary(projectId, url);
        await refresh();
    }, [backend, projectId, refresh]);

    return { items, busy, importFiles, add, remove };
}

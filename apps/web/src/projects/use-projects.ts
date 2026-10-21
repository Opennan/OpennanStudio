import { useCallback, useEffect, useState } from "react";
import type { CreateProjectInput, ProjectSummary } from "@opennan/timeline-core";
import { useStudioRuntime } from "../platform/runtime-context";
import type { PersistState, StorageUsage } from "../platform/storage";
import { errorMessage } from "../ui/format";

export interface StorageInfo {
    usage: StorageUsage | null;
    persist: PersistState;
}

export function useProjects() {
    const { backend, forgetProject, storage } = useStudioRuntime();
    const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
    const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setProjects(await backend.listProjects());
            setError(null);
        } catch (cause) {
            setError(errorMessage(cause));
            setProjects([]);
        }
        const [usage, persist] = await Promise.all([storage.estimate(), storage.persisted()]);
        setStorageInfo({ usage, persist });
    }, [backend, storage]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const create = useCallback(async (input: CreateProjectInput) => {
        await storage.ensurePersisted();
        return backend.createProject(input);
    }, [backend, storage]);
    const rename = useCallback(async (projectId: string, name: string) => {
        await backend.updateProject(projectId, { name });
        await refresh();
    }, [backend, refresh]);
    const remove = useCallback(async (projectId: string) => {
        await backend.deleteProject(projectId);
        forgetProject(projectId);
        await refresh();
    }, [backend, forgetProject, refresh]);

    return { projects, storageInfo, error, create, rename, remove };
}

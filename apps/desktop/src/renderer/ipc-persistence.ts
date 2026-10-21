// LocalBackend persistence in the renderer: project documents go to main's SQLite store over IPC. Media is
// not stored through here (DesktopBackend.uploadFile hands main a file path instead of a Blob), so getBlob
// answers null without a round trip and putBlob refuses. Nor is it deleted through here: LocalBackend would delete
// every file a project references, which may be a cloud working copy's; main deletes a project's files with its row,
// and only the files that project owns.
import type { LocalPersistence } from "@opennan/timeline-core";
import type { DesktopBridge } from "../shared/bridge";

export function createIpcPersistence(bridge: Pick<DesktopBridge, "persistence" | "media">): LocalPersistence {
    return {
        loadProject: (projectId) => bridge.persistence.load(projectId),
        saveProject: (projectId, state) => bridge.persistence.save(projectId, state),
        listProjects: () => bridge.persistence.list(),
        deleteProject: (projectId) => bridge.persistence.delete(projectId),
        async putBlob() {
            throw new Error("Desktop stores media through DesktopBackend.uploadFile");
        },
        async getBlob() {
            return null;
        },
        deleteBlob: async () => undefined,
    };
}

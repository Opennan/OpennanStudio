import { createMemoryPersistence, createEmptyProject } from "@opennan/timeline-core";
import { localCacheReferences, pinnedCacheIds } from "./web-cloud";

describe("web cloud media pins (9a.1)", () => {
    it("pins only the cache's own files among a project's local URLs", () => {
        expect(pinnedCacheIds(["opennan-local://media/c-0011-5-aa", "opennan-local://media/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", "https://cdn.opennan.com/x"])).toEqual(["c-0011-5-aa"]);
    });

    it("finds cache ids a local project names (never evicted)", async () => {
        const persistence = createMemoryPersistence();
        const project = createEmptyProject("p1");
        await persistence.saveProject("p1", { ...project, library: [{ url: "opennan-local://media/c-ab-1-ff", name: "x", size: 1, mimeType: "video/mp4" }] });
        await persistence.saveProject("p2", { ...createEmptyProject("p2") });
        expect([...(await localCacheReferences(persistence))]).toEqual(["c-ab-1-ff"]);
    });
});

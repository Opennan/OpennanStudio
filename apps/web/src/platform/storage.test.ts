import { createStorageGuard, storageErrorMessage } from "./storage";

describe("browser storage", () => {
    it("asks for persistent storage once and remembers the answer", async () => {
        const persist = vi.fn(async () => true);
        const guard = createStorageGuard({ persisted: async () => false, persist });
        expect(await guard.persisted()).toBe("best-effort");
        expect(await guard.ensurePersisted()).toBe("persistent");
        expect(await guard.ensurePersisted()).toBe("persistent");
        expect(persist).toHaveBeenCalledTimes(1);
        expect(await createStorageGuard({ persisted: async () => false, persist: async () => false }).ensurePersisted()).toBe("best-effort");
        const notAsked = vi.fn(async () => true);
        expect(await createStorageGuard({ persisted: async () => true, persist: notAsked }).ensurePersisted()).toBe("persistent");
        expect(notAsked).not.toHaveBeenCalled();
        expect(await createStorageGuard(undefined).ensurePersisted()).toBe("unsupported");
    });

    it("reports usage and explains a full storage", async () => {
        const MB = 1024 * 1024;
        const usage = await createStorageGuard({ estimate: async () => ({ usage: 512 * MB, quota: 1024 * MB }) }).estimate();
        expect(usage).toEqual({ usage: 512 * MB, quota: 1024 * MB });
        expect(await createStorageGuard(null).estimate()).toBeNull();
        const full = new DOMException("The quota has been exceeded.", "QuotaExceededError");
        expect(storageErrorMessage(full, usage)).toBe("Not enough browser storage (512.0 MB of 1.00 GB used)");
        expect(storageErrorMessage(full, null)).toBe("Not enough browser storage");
        expect(storageErrorMessage(new Error("Disk on fire"), usage)).toBeNull();
    });
});

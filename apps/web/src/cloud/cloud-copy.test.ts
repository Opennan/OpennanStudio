import { deletedIn, share, shotsEditUrl, storageFull, storageFullMessage, syncDetail, syncLabel } from "./cloud-copy";

const storage = { mediaBytes: 2 * 1024 ** 3, mediaLimitBytes: 2 * 1024 ** 3, projectDataBytes: 0, projectDataLimitBytes: 250 * 1024 ** 2, tempBytes: 0, tempLimitBytes: 0, uploadsToday: 0, uploadsPerDay: 100, uploadBytesToday: 0, uploadBytesPerDay: 0, state: "over_quota" as const };

describe("cloud copy", () => {
    it("names every sync state in words", () => {
        expect(syncLabel({ kind: "saved", at: 0 })).toBe("Saved");
        expect(syncLabel({ kind: "syncing", pending: 2, uploading: 3, uploaded: 1 })).toBe("Uploading 2 of 4");
        expect(syncLabel({ kind: "syncing", pending: 2, uploading: 0, uploaded: 0 })).toBe("Syncing…");
        expect(syncLabel({ kind: "offline", pending: 3, since: 0 })).toBe("Offline (3 pending)");
        expect(syncLabel({ kind: "conflict", items: [], pending: 0 })).toBe("Conflict");
        expect(syncLabel({ kind: "signed-out", pending: 1 })).toBe("Sign in to sync");
        expect(syncLabel({ kind: "over-quota", reason: "storage", pending: 0 })).toBe("Storage full");
        expect(syncDetail({ kind: "offline", pending: 1, since: 0 })).toMatch(/saved on this device/);
        expect(syncDetail({ kind: "syncing", pending: 1, uploading: 1, uploaded: 0, message: "You reached today's upload limit." })).toBe("You reached today's upload limit.");
    });

    it("says storage is full and that more is coming", () => {
        expect(storageFull(storage)).toBe(true);
        expect(storageFullMessage(storage)).toBe("Cloud storage is full (2.00 GB of 2.00 GB). Edits still sync; new media can't upload. More storage is coming soon.");
        expect(share(1, 4)).toBe(25);
        expect(share(5, 0)).toBe(0);
    });

    it("counts the trash's days left", () => {
        const now = Date.UTC(2026, 9, 20);
        expect(deletedIn(now - 86_400_000, now)).toBe("Deleted in 6 days");
        expect(deletedIn(now - 6.5 * 86_400_000, now)).toBe("Deleted in 1 day");
    });

    it("links a cloud project's shots to its page on opennan.com (9a.1); local projects have none", () => {
        expect(shotsEditUrl("https://opennan.com", "cloud-p_1")).toBe("https://opennan.com/video/p_1");
        expect(shotsEditUrl("https://opennan.com/", "cloud-a b")).toBe("https://opennan.com/video/a%20b");
        expect(shotsEditUrl("https://opennan.com", "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b")).toBeNull();
    });
});

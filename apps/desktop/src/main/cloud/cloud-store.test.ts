// The cloud projects' file store: one folder per account (hashed), JSON files written temp-then-rename, and
// nothing outside the known namespaces and keys.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCloudFileStore, type CloudFileStore } from "./cloud-store";

describe("cloud file store", () => {
    let root: string;
    let store: CloudFileStore;
    const folder = (account: string) => path.join(root, createHash("sha256").update(account).digest("hex").slice(0, 24));

    beforeEach(() => {
        root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-cloud-store-"))), "cloud");
        store = createCloudFileStore({ root, maxValueBytes: 1000 });
    });
    afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

    it("keeps JSON values per account, namespace and key", async () => {
        await store.put("ada@example.com", "sync", "cloud-p1", { revision: 3, pending: [] });
        await store.put("ada@example.com", "mirror", "cloud-p1", { meta: { name: "Trip" } });
        expect(await store.get("ada@example.com", "sync", "cloud-p1")).toEqual({ revision: 3, pending: [] });
        expect(await store.get("ada@example.com", "sync", "cloud-p2")).toBeNull();
        expect(await store.keys("ada@example.com", "sync")).toEqual(["cloud-p1"]);
        expect(await store.keys("ada@example.com", "urls")).toEqual([]);
        expect(fs.existsSync(path.join(folder("ada@example.com"), "sync", "cloud-p1.json"))).toBe(true);
        // Another account sees nothing of it.
        expect(await store.get("bob@example.com", "sync", "cloud-p1")).toBeNull();
        expect(await store.keys("bob@example.com", "sync")).toEqual([]);
        await store.delete("ada@example.com", "sync", "cloud-p1");
        await store.delete("ada@example.com", "sync", "cloud-p1");
        expect(await store.get("ada@example.com", "sync", "cloud-p1")).toBeNull();
    });

    it("writes temp-then-rename, privately, and leaves no temp files", async () => {
        await store.put("a", "lists", "active", [1, 2, 3]);
        await store.put("a", "lists", "active", [4]);
        const dir = path.join(folder("a"), "lists");
        expect(fs.readdirSync(dir)).toEqual(["active.json"]);
        expect(await store.get("a", "lists", "active")).toEqual([4]);
        if (process.platform !== "win32") {
            expect(fs.statSync(path.join(dir, "active.json")).mode & 0o777).toBe(0o600);
            expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        }
    });

    it("keeps keys that differ only in case apart, and keys with colons (case-insensitive and Windows file systems)", async () => {
        await store.put("a", "uploads", "Abc", 1);
        await store.put("a", "uploads", "abc", 2);
        await store.put("a", "uploads", "sha:ff", 3);
        expect(await store.get("a", "uploads", "Abc")).toBe(1);
        expect(await store.get("a", "uploads", "abc")).toBe(2);
        expect(await store.get("a", "uploads", "sha:ff")).toBe(3);
        expect((await store.keys("a", "uploads")).sort()).toEqual(["Abc", "abc", "sha:ff"].sort());
        for (const name of fs.readdirSync(path.join(folder("a"), "uploads"))) expect(name).toMatch(/^[a-z0-9_^~-]+\.json$/);
    });

    it("refuses unknown namespaces, bad keys, path tricks, empty accounts and oversized values", async () => {
        for (const namespace of ["../sync", "settings", "", "SYNC"]) await expect(store.put("a", namespace as never, "k", 1)).rejects.toThrow("namespace");
        for (const key of ["../x", "a/b", "a\\b", "", ".", "..", "a.json", "x".repeat(121), "a b"]) {
            await expect(store.put("a", "sync", key, 1)).rejects.toThrow("key");
            await expect(store.get("a", "sync", key)).rejects.toThrow("key");
            await expect(store.delete("a", "sync", key)).rejects.toThrow("key");
        }
        await expect(store.put("", "sync", "k", 1)).rejects.toThrow("account");
        await expect(store.put("x".repeat(321), "sync", "k", 1)).rejects.toThrow("account");
        await expect(store.put("a", "sync", "k", "x".repeat(2000))).rejects.toThrow("too large");
        await expect(store.put("a", "sync", "k", undefined)).rejects.toThrow("JSON");
        // An account name is hashed: it never becomes a path.
        await store.put("../../etc", "sync", "k", 1);
        expect(fs.readdirSync(root)).toEqual([path.basename(folder("../../etc"))]);
    });

    it("skips files it did not write; a damaged record is set aside and reported, never read as missing", async () => {
        await store.put("a", "sync", "good", 1);
        const dir = path.join(folder("a"), "sync");
        fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
        fs.writeFileSync(path.join(dir, "empty.json"), "");
        fs.writeFileSync(path.join(dir, "notes.txt"), "x");
        expect((await store.keys("a", "sync")).sort()).toEqual(["bad", "empty", "good"]);
        await expect(store.get("a", "sync", "bad")).rejects.toThrow("damaged");
        await expect(store.get("a", "sync", "empty")).rejects.toThrow("damaged");
        expect(fs.readFileSync(path.join(dir, "bad.json.corrupt"), "utf8")).toBe("{nope");
        expect(fs.existsSync(path.join(dir, "empty.json.corrupt"))).toBe(true);
        expect(await store.keys("a", "sync")).toEqual(["good"]);
        expect(await store.get("a", "sync", "bad")).toBeNull();
    });

    it("writes to one key land in the order they were asked, and a read waits for them", async () => {
        const big = (n: number) => ({ n, pad: "x".repeat(400 - n * 10) });
        const writes = Array.from({ length: 20 }, (_, n) => store.put("a", "mirror", "cloud-p", big(n)));
        const read = store.get<{ n: number }>("a", "mirror", "cloud-p");
        await Promise.all(writes);
        expect((await read)?.n).toBe(19);
        expect((await store.get<{ n: number }>("a", "mirror", "cloud-p"))?.n).toBe(19);
        const put = store.put("a", "mirror", "cloud-p", big(1));
        const removed = store.delete("a", "mirror", "cloud-p");
        await Promise.all([put, removed]);
        expect(await store.get("a", "mirror", "cloud-p")).toBeNull();
    });

    it("sweeps temp files a crash left behind when it starts", async () => {
        await store.put("a", "sync", "k", 1);
        const dir = path.join(folder("a"), "sync");
        fs.writeFileSync(path.join(dir, "k.json.0123.tmp"), "half");
        const restarted = createCloudFileStore({ root });
        expect(await restarted.get("a", "sync", "k")).toBe(1);
        expect(fs.readdirSync(dir)).toEqual(["k.json"]);
    });
});

import { markLeaving, MAX_TOASTS, removeToast, toastLifetimeMs, upsertToast, type QueuedToast } from "./toast-queue";

const toast = (id: string, kind: QueuedToast["kind"] = "info", message = id): QueuedToast => ({ id, kind, message });

describe("toast queue", () => {
    it("appends new toasts and replaces one with the same id in place", () => {
        let list = upsertToast([], toast("a", "loading", "Importing"));
        list = upsertToast(list, toast("b"));
        list = upsertToast(list, toast("a", "success", "Imported"));
        expect(list.map((t) => `${t.id}:${t.kind}:${t.message}`)).toEqual(["a:success:Imported", "b:info:b"]);
    });

    it("keeps only the newest toasts", () => {
        let list: QueuedToast[] = [];
        for (let i = 0; i < MAX_TOASTS + 2; i += 1) list = upsertToast(list, toast(`t${i}`));
        expect(list.map((t) => t.id)).toEqual(["t2", "t3", "t4", "t5", "t6"]);
    });

    it("removes by id and gives loading toasts no timeout", () => {
        expect(removeToast([toast("a"), toast("b")], "a").map((t) => t.id)).toEqual(["b"]);
        expect(toastLifetimeMs("loading")).toBeNull();
        expect(toastLifetimeMs("error")).toBe(6_000);
        expect(toastLifetimeMs("success")).toBe(4_000);
    });

    it("marks a toast as leaving before it is removed", () => {
        const list = [{ id: "a", kind: "info" as const, message: "A" }, { id: "b", kind: "info" as const, message: "B" }];
        expect(markLeaving(list, "a").map((t) => Boolean(t.leaving))).toEqual([true, false]);
    });
});

describe("toast actions (phase 11)", () => {
    it("keeps an action through replacement and gives toasts with an action time to be clicked", () => {
        const retry = vi.fn();
        const list = upsertToast([], { id: "job", kind: "error", message: "Isolate voice failed. You were not charged.", action: { label: "Retry", run: retry } });
        expect(list[0].action?.label).toBe("Retry");
        list[0].action!.run();
        expect(retry).toHaveBeenCalledTimes(1);
        expect(toastLifetimeMs("error", true)).toBeGreaterThan(toastLifetimeMs("error")!);
    });
});

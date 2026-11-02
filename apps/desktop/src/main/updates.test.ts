import { EventEmitter } from "node:events";
import { startUpdates, updatesEnabled, UPDATE_INTERVAL_MS } from "./updates";

describe("update gate", () => {
    it.each([
        [true, true, undefined, true], [false, true, undefined, false], [true, false, undefined, false],
        [true, "true", undefined, false], [true, true, "1", false],
    ])("packaged=%s flag=%s disable=%s -> %s", (isPackaged, flag, disable, expected) => {
        expect(updatesEnabled({ isPackaged: isPackaged as boolean, packageJson: { opennanUpdates: flag }, env: { OPENNAN_DISABLE_UPDATES: disable as string | undefined } })).toBe(expected);
    });

    it("never loads the updater when disabled", () => {
        const load = vi.fn();
        startUpdates({ isPackaged: false, packageJson: { opennanUpdates: true }, env: {} }, load)();
        expect(load).not.toHaveBeenCalled();
    });

    it("checks when enabled and swallows errors", async () => {
        const updater = { autoDownload: false, autoInstallOnAppQuit: false, checkForUpdatesAndNotify: vi.fn(async () => { throw new Error("offline"); }) };
        const log = vi.fn();
        const stop = startUpdates({ isPackaged: true, packageJson: { opennanUpdates: true }, env: {} }, () => updater, log);
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("offline")));
        expect(updater.autoDownload).toBe(true);
        stop();
        expect(startUpdates({ isPackaged: true, packageJson: { opennanUpdates: true }, env: {} }, () => { throw new Error("missing"); }, log)).toBeTypeOf("function");
    });

    it("handles emitted download errors and stops polling on cleanup", async () => {
        vi.useFakeTimers();
        try {
            const updater = Object.assign(new EventEmitter(), {
                autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true, allowDowngrade: true,
                checkForUpdatesAndNotify: vi.fn(async () => undefined),
            });
            const log = vi.fn();
            const stop = startUpdates({ isPackaged: true, packageJson: { opennanUpdates: true }, env: {} }, () => updater, log);
            updater.emit("error", new Error("download unavailable"));
            expect(log).toHaveBeenCalledWith(expect.stringContaining("download unavailable"));
            expect(updater.autoInstallOnAppQuit).toBe(true);
            expect(updater.allowPrerelease).toBe(false);
            expect(updater.allowDowngrade).toBe(false);
            await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
            expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
            stop();
            await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
            expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
            expect(updater.listenerCount("error")).toBe(0);
        } finally { vi.useRealTimers(); }
    });

    it("does not start overlapping checks while offline requests are pending", async () => {
        vi.useFakeTimers();
        try {
            let finish!: () => void;
            const updater = { autoDownload: false, autoInstallOnAppQuit: false,
                checkForUpdatesAndNotify: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
            };
            const stop = startUpdates({ isPackaged: true, packageJson: { opennanUpdates: true }, env: {} }, () => updater);
            await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2);
            expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
            finish();
            await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
            expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
            stop(); finish();
        } finally { vi.useRealTimers(); }
    });
});

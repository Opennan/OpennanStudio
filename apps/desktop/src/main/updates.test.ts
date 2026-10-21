import { startUpdates, updatesEnabled } from "./updates";

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
});

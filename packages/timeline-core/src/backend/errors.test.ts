import { TimelineTimeoutError, withTimeout } from "./errors";

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves when the task settles first", async () => {
    await expect(withTimeout(Promise.resolve(4), 100)).resolves.toBe(4);
  });

  it("rejects with TimelineTimeoutError after the budget", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 100, undefined, "moveScenes");
    const assertion = expect(pending).rejects.toBeInstanceOf(TimelineTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await expect(pending).rejects.toThrow("moveScenes timed out");
  });
});

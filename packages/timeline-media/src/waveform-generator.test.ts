// Coverage for waveform extraction performance contracts and MediaEnvironment use.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaveformCache } from "./waveform-generator";

function waveformGeneratorSource(): string {
  return readFileSync(resolve(__dirname, "waveform-generator.ts"), "utf8");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createWaveformCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts stale pending waveform media fetches", () => {
    const source = waveformGeneratorSource();
    expect(source).toContain("const pending = new Map<string, AbortController>();");
    expect(source).toContain("const backendWaveform = await fetchEnvironmentWaveform(env, url, signal);");
    expect(source).toContain("pending.set(url, controller);");
    expect(source).toContain("if (!keepUrls.has(url)) controller.abort();");
  });

  it("bounds completed waveform cache entries", () => {
    const source = waveformGeneratorSource();
    expect(source).toContain("const MAX_WAVEFORM_CACHE_ENTRIES = 48;");
    expect(source).toContain("while (cache.size > MAX_WAVEFORM_CACHE_ENTRIES && accessOrder.length > 0)");
  });

  it("caps concurrent waveform fetch and decode work", () => {
    const source = waveformGeneratorSource();
    const requestBlock = source.slice(source.indexOf("request(url: string)"), source.indexOf("cancelUnused(keepUrls: Set<string>)"));
    expect(source).toContain("const MAX_CONCURRENT_WAVEFORM_REQUESTS = 2;");
    expect(requestBlock).toContain("if (pending.size >= MAX_CONCURRENT_WAVEFORM_REQUESTS) return;");
  });

  it("uses the environment waveform and never fetches bytes when it returns peaks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const peaks = { peaks: Float32Array.from([0.5]), sampleRate: 50, duration: 0.02 };
    const cache = createWaveformCache({ resolveMediaUrl: (u) => u, fetchWaveform: async () => peaks });
    const updates = vi.fn();
    cache.onUpdate = updates;

    cache.request("https://cdn.test/a.mp3");
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.get("https://cdn.test/a.mp3")).toBe(peaks);
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it("skips byte fetches the environment forbids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cache = createWaveformCache({ resolveMediaUrl: (u) => u, canFetchMediaBytes: () => false });

    cache.request("opennan-local://media/x");
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches bytes through the resolved url with auth headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ArrayBuffer(8)));
    const cache = createWaveformCache({
      resolveMediaUrl: (u) => `https://proxy.test/?u=${encodeURIComponent(u)}`,
      getAuthHeaders: async () => ({ Authorization: "Bearer t" }),
    });

    cache.request("https://cdn.test/a.mp3");
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://proxy.test/?u=https%3A%2F%2Fcdn.test%2Fa.mp3");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer t" } });
  });
});

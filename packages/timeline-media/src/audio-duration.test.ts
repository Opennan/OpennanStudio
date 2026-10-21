// Verifies shared metadata probing for audio clip durations.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAudioDuration, __clearAudioDurationCacheForTests } from "./audio-duration";

class FakeAudio {
  static instances: FakeAudio[] = [];
  duration = 12.5;
  preload = "";
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";

  constructor(src?: string) {
    if (src) this.src = src;
    FakeAudio.instances.push(this);
  }

  pause = vi.fn();
}

describe("loadAudioDuration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeAudio.instances = [];
    __clearAudioDurationCacheForTests();
  });

  it("shares pending metadata probes for the same resolved URL", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);

    const first = loadAudioDuration("https://cdn.example/audio.mp3");
    const second = loadAudioDuration("https://cdn.example/audio.mp3");

    expect(FakeAudio.instances).toHaveLength(1);

    FakeAudio.instances[0].onloadedmetadata?.();

    await expect(first).resolves.toBe(12.5);
    await expect(second).resolves.toBe(12.5);
  });

  it("returns cached durations without creating another audio element", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);

    const first = loadAudioDuration("https://cdn.example/cached.mp3");
    FakeAudio.instances[0].onloadedmetadata?.();
    await expect(first).resolves.toBe(12.5);

    await expect(loadAudioDuration("https://cdn.example/cached.mp3")).resolves.toBe(12.5);

    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("cleans up metadata probes after settling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);

    const duration = loadAudioDuration("https://cdn.example/cleanup.mp3");
    const audio = FakeAudio.instances[0];
    audio.onloadedmetadata?.();

    await expect(duration).resolves.toBe(12.5);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.onloadedmetadata).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(audio.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a metadata probe and cleans up the audio element", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);
    const controller = new AbortController();

    const duration = loadAudioDuration("https://cdn.example/abort.mp3", {
      fallbackSeconds: 7,
      signal: controller.signal,
    });
    const audio = FakeAudio.instances[0];

    controller.abort();

    await expect(duration).resolves.toBe(7);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.onloadedmetadata).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(audio.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start metadata loading when already aborted", async () => {
    vi.stubGlobal("Audio", FakeAudio);
    const controller = new AbortController();
    controller.abort();

    await expect(loadAudioDuration("https://cdn.example/skip.mp3", {
      fallbackSeconds: 9,
      signal: controller.signal,
    })).resolves.toBe(9);

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("uses the url unchanged when no resolver is passed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", { location: { origin: "http://localhost:4317" }, setTimeout, clearTimeout });

    const sourceUrl = "http://localhost:8001/uploads/project/dialogue.mp3";
    const duration = loadAudioDuration(sourceUrl);

    expect(FakeAudio.instances[0].src).toBe(sourceUrl);
    FakeAudio.instances[0].onloadedmetadata?.();
    await expect(duration).resolves.toBe(12.5);
  });

  it("routes the url through the injected resolver", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", { location: { origin: "http://localhost:4317" }, setTimeout, clearTimeout });

    const duration = loadAudioDuration("opennan-local://media/a", { resolveUrl: () => "blob:http://localhost:4317/a" });

    expect(FakeAudio.instances[0].src).toBe("blob:http://localhost:4317/a");
    FakeAudio.instances[0].onloadedmetadata?.();
    await expect(duration).resolves.toBe(12.5);
  });
});

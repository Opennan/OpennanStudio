import type { WaveformCache, WaveformData } from "@opennan/timeline-core/timeline/canvas/types";
import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "./media-environment";

const PEAKS_PER_SECOND = 50;
const MAX_WAVEFORM_CACHE_ENTRIES = 48;
const MAX_CONCURRENT_WAVEFORM_REQUESTS = 2;

type WindowWithWebkitAudioContext = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function shouldSkipWaveformExtraction(env: MediaEnvironment, url: string): boolean {
  return env.canFetchMediaBytes ? !env.canFetchMediaBytes(url) : false;
}

async function fetchEnvironmentWaveform(env: MediaEnvironment, url: string, signal: AbortSignal): Promise<WaveformData | null> {
  if (!env.fetchWaveform) return null;
  try {
    return await env.fetchWaveform(url, signal);
  } catch {
    return null;
  }
}

/**
 * Cache for audio waveform peak data extracted via WebAudio API.
 * Peak data is compact, but long editor sessions can touch many audio files,
 * so completed entries are bounded with an LRU-style access list.
 */
export function createWaveformCache(env: MediaEnvironment = IDENTITY_MEDIA_ENVIRONMENT): WaveformCache {
  const cache = new Map<string, WaveformData>();
  const accessOrder: string[] = [];
  const pending = new Map<string, AbortController>();
  let onUpdate: (() => void) | null = null;

  function touchCacheEntry(url: string) {
    const existingIndex = accessOrder.indexOf(url);
    if (existingIndex >= 0) accessOrder.splice(existingIndex, 1);
    accessOrder.push(url);
  }

  function pruneCache() {
    while (cache.size > MAX_WAVEFORM_CACHE_ENTRIES && accessOrder.length > 0) {
      const oldest = accessOrder.shift();
      if (oldest) cache.delete(oldest);
    }
  }

  async function extractPeaks(url: string, signal: AbortSignal): Promise<WaveformData | null> {
    let audioCtx: AudioContext | null = null;
    try {
      const backendWaveform = await fetchEnvironmentWaveform(env, url, signal);
      if (backendWaveform) return backendWaveform;
      if (shouldSkipWaveformExtraction(env, url)) return null;

      const headers = env.getAuthHeaders ? await env.getAuthHeaders() : undefined;
      const response = await fetch(env.resolveMediaUrl(url), { signal, headers });
      if (!response.ok) return null;

      const arrayBuffer = await response.arrayBuffer();
      if (signal.aborted) return null;
      const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
      if (!AudioContextCtor) return null;
      audioCtx = new AudioContextCtor();

      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      if (signal.aborted) return null;
      const channelData = audioBuffer.getChannelData(0); // mono / left channel
      const duration = audioBuffer.duration;
      const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
      const peaks = new Float32Array(totalPeaks);
      const samplesPerPeak = Math.floor(channelData.length / totalPeaks);

      for (let i = 0; i < totalPeaks; i++) {
        const start = i * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, channelData.length);
        let max = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(channelData[j]);
          if (abs > max) max = abs;
        }
        peaks[i] = max;
      }

      await audioCtx.close().catch(() => {});

      return { peaks, sampleRate: PEAKS_PER_SECOND, duration };
    } catch (err) {
      if (signal.aborted || (err as { name?: string })?.name === "AbortError") return null;
      console.warn("[waveform] Failed to extract peaks for", url, err);
      return null;
    } finally {
      if (audioCtx && audioCtx.state !== "closed") {
        await audioCtx.close().catch(() => {});
      }
    }
  }

  return {
    get(url: string): WaveformData | undefined {
      const data = cache.get(url);
      if (data) touchCacheEntry(url);
      return data;
    },

    request(url: string) {
      if (cache.has(url)) {
        touchCacheEntry(url);
        return;
      }
      if (pending.has(url)) return;
      if (pending.size >= MAX_CONCURRENT_WAVEFORM_REQUESTS) return;
      const controller = new AbortController();
      pending.set(url, controller);

      extractPeaks(url, controller.signal).then((data) => {
        pending.delete(url);
        if (data && !controller.signal.aborted) {
          cache.set(url, data);
          touchCacheEntry(url);
          pruneCache();
          onUpdate?.();
        }
      });
    },

    cancelUnused(keepUrls: Set<string>) {
      for (const [url, controller] of pending) {
        if (!keepUrls.has(url)) controller.abort();
      }
    },

    get onUpdate() { return onUpdate; },
    set onUpdate(fn: (() => void) | null) { onUpdate = fn; },
  };
}

// Shared client-side audio metadata duration probing with in-flight dedupe.

type AudioDurationOptions = {
  fallbackSeconds?: number;
  resolveUrl?: (url: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FALLBACK_SECONDS = 0;
const durationCache = new Map<string, number>();

type DurationProbeEntry = {
  cancel: () => void;
  consumers: number;
  promise: Promise<number | null>;
  settled: boolean;
};

const durationProbes = new Map<string, DurationProbeEntry>();

function normalizeDuration(duration: number): number | null {
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function createDurationProbe(resolvedUrl: string, timeoutMs: number): DurationProbeEntry {
  const audio = new Audio(resolvedUrl);
  let timeout: number | null = null;
  let resolveProbe: (duration: number | null) => void = () => {};
  let settled = false;

  const promise = new Promise<number | null>((resolve) => {
    resolveProbe = resolve;
  });

  const entry: DurationProbeEntry = {
    cancel: () => {},
    consumers: 0,
    promise,
    settled: false,
  };

  const finish = (duration: number | null) => {
    if (settled) return;
    settled = true;
    entry.settled = true;
    if (timeout != null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
    audio.onloadedmetadata = null;
    audio.onerror = null;
    audio.pause();
    audio.src = "";
    const normalized = duration == null ? null : normalizeDuration(duration);
    if (normalized != null) durationCache.set(resolvedUrl, normalized);
    if (durationProbes.get(resolvedUrl) === entry) durationProbes.delete(resolvedUrl);
    resolveProbe(normalized);
  };

  entry.cancel = () => finish(null);

  audio.preload = "metadata";
  audio.onloadedmetadata = () => finish(audio.duration);
  audio.onerror = () => finish(null);
  timeout = window.setTimeout(() => finish(null), timeoutMs);

  return entry;
}

function probeAudioDuration(resolvedUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  const cached = durationCache.get(resolvedUrl);
  if (cached != null) return Promise.resolve(cached);
  if (signal?.aborted) return Promise.resolve(null);

  let entry = durationProbes.get(resolvedUrl);
  if (!entry) {
    entry = createDurationProbe(resolvedUrl, timeoutMs);
    durationProbes.set(resolvedUrl, entry);
  }

  entry.consumers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.consumers = Math.max(0, entry.consumers - 1);
    if (entry.consumers === 0 && !entry.settled) entry.cancel();
  };

  if (!signal) {
    return entry.promise.finally(release);
  }

  return new Promise<number | null>((resolve) => {
    const onAbort = () => {
      release();
      resolve(null);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(resolve, () => resolve(null)).finally(() => {
      signal.removeEventListener("abort", onAbort);
      release();
    });
  });
}

export async function loadAudioDuration(url: string, options: AudioDurationOptions = {}): Promise<number> {
  const resolvedUrl = (options.resolveUrl ?? ((value: string) => value))(url);
  const fallbackSeconds = options.fallbackSeconds ?? DEFAULT_FALLBACK_SECONDS;
  const duration = await probeAudioDuration(resolvedUrl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  return duration ?? fallbackSeconds;
}

export function __clearAudioDurationCacheForTests() {
  durationCache.clear();
  durationProbes.clear();
}

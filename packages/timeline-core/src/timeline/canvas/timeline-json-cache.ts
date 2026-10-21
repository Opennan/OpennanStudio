// Bounded JSON caches for read-only canvas timeline render and snap paths.

const EMPTY_TIMES: number[] = [];
const EMPTY_CONFIG: Record<string, unknown> = {};
const MAX_TIMELINE_JSON_CACHE_ENTRIES = 400;

const keyframeTimesCache = new Map<string, number[]>();
const keyframeDurationTimesCache = new Map<string, number[]>();
const cardConfigCache = new Map<string, Record<string, unknown>>();
const textStyleCache = new Map<string, Record<string, unknown>>();

function pruneCache<K, V>(cache: Map<K, V>) {
  while (cache.size > MAX_TIMELINE_JSON_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

export function getCachedClipKeyframeTimes(
  keyframesJson: string | null | undefined,
  duration: number,
): number[] {
  if (!keyframesJson) return EMPTY_TIMES;

  let times = keyframeTimesCache.get(keyframesJson);
  if (!times) {
    try {
      const parsed = JSON.parse(keyframesJson) as unknown;
      const keyframes = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { keyframes?: unknown }).keyframes)
          ? (parsed as { keyframes: unknown[] }).keyframes
          : [];

      times = keyframes
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const time = Number((item as { time?: unknown }).time);
          return Number.isFinite(time) && time >= 0 ? time : null;
        })
        .filter((time): time is number => time !== null)
        .sort((a, b) => a - b);
    } catch {
      times = EMPTY_TIMES;
    }
    keyframeTimesCache.set(keyframesJson, times);
    pruneCache(keyframeTimesCache);
  }

  const safeDuration = Math.max(0, duration);
  if (times.length === 0) return EMPTY_TIMES;
  if (times[times.length - 1] <= safeDuration) return times;

  const durationKey = `${safeDuration}\u0000${keyframesJson}`;
  const cachedDurationTimes = keyframeDurationTimesCache.get(durationKey);
  if (cachedDurationTimes) return cachedDurationTimes;

  const filteredTimes = times.filter((time) => time <= safeDuration);
  keyframeDurationTimesCache.set(durationKey, filteredTimes);
  pruneCache(keyframeDurationTimesCache);
  return filteredTimes;
}

export function parseCachedSceneCardConfig(cardConfig: string | null | undefined): Record<string, unknown> {
  if (!cardConfig) return EMPTY_CONFIG;

  const cached = cardConfigCache.get(cardConfig);
  if (cached) return cached;

  let parsedConfig = EMPTY_CONFIG;
  try {
    const parsed = JSON.parse(cardConfig);
    parsedConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : EMPTY_CONFIG;
  } catch {
    parsedConfig = EMPTY_CONFIG;
  }

  cardConfigCache.set(cardConfig, parsedConfig);
  pruneCache(cardConfigCache);
  return parsedConfig;
}

export function parseCachedTextStyle(textStyle: string | null | undefined): Record<string, unknown> {
  if (!textStyle) return EMPTY_CONFIG;

  const cached = textStyleCache.get(textStyle);
  if (cached) return cached;

  let parsedStyle = EMPTY_CONFIG;
  try {
    const parsed = JSON.parse(textStyle);
    parsedStyle = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : EMPTY_CONFIG;
  } catch {
    parsedStyle = EMPTY_CONFIG;
  }

  textStyleCache.set(textStyle, parsedStyle);
  pruneCache(textStyleCache);
  return parsedStyle;
}

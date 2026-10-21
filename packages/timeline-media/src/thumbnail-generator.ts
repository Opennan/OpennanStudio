import type { ThumbnailCache } from "@opennan/timeline-core/timeline/canvas/types";
import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "./media-environment";
import { decodeFramesAtTimes, isWebCodecsFrameDecodeSupported, releaseUnusedInputs } from "./webcodecs-frame-source";

const MAX_CACHE_SIZE = 500;
const MAX_VIDEO_POOL_SIZE = 16;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 4;

// Extensions that indicate an image URL (not video)
const IMAGE_EXTS = /\.(jpe?g|png|webp|gif|avif|bmp|svg)([?#]|$)/i;

type PendingThumbnailRequest = {
  url: string;
  cancel: () => void;
};

function isImageUrl(url: string): boolean {
  // R2/S3 URLs often have no extension but contain image hints
  if (IMAGE_EXTS.test(url)) return true;
  // Blob URLs are ambiguous — treat as images if requested at time=0
  if (url.startsWith("blob:")) return false;
  // URLs containing "thumb", "image", "poster" are likely images
  if (/thumb|image|poster|webp|blurhash/i.test(url)) return true;
  return false;
}

export function shouldUseAnonymousVideoFrameCors(url: string, origin?: string): boolean {
  const baseOrigin = origin || (typeof window !== "undefined" ? window.location.origin : "");
  if (!baseOrigin) return false;
  try {
    const parsed = new URL(url, baseOrigin);
    if (parsed.protocol === "blob:" || parsed.protocol === "data:") return false;
    return parsed.origin === new URL(baseOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * LRU cache for thumbnails as ImageBitmaps.
 * Handles both image URLs (via <img>) and video URLs (via <video> + seek).
 */
export function createThumbnailCache(env: MediaEnvironment = IDENTITY_MEDIA_ENVIRONMENT): ThumbnailCache {
  const cache = new Map<string, ImageBitmap>();
  const accessOrder: string[] = [];
  const pending = new Map<string, PendingThumbnailRequest>();
  const videoPool = new Map<string, HTMLVideoElement>();
  const videoAccessOrder: string[] = [];
  const activeVideoRequests = new Map<string, number>();

  let onUpdate: (() => void) | null = null;

  function makeKey(url: string, time: number): string {
    return `${url}@${time.toFixed(2)}`;
  }

  function touch(key: string) {
    const idx = accessOrder.indexOf(key);
    if (idx !== -1) accessOrder.splice(idx, 1);
    accessOrder.push(key);
  }

  function evict() {
    while (cache.size > MAX_CACHE_SIZE && accessOrder.length > 0) {
      const oldest = accessOrder.shift()!;
      const bitmap = cache.get(oldest);
      if (bitmap) {
        bitmap.close();
        cache.delete(oldest);
      }
    }
  }

  function touchVideo(url: string) {
    const idx = videoAccessOrder.indexOf(url);
    if (idx !== -1) videoAccessOrder.splice(idx, 1);
    videoAccessOrder.push(url);
  }

  function releaseVideo(url: string) {
    if ((activeVideoRequests.get(url) ?? 0) > 0) return;
    const video = videoPool.get(url);
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    videoPool.delete(url);
  }

  function pruneVideoPool() {
    while (videoPool.size > MAX_VIDEO_POOL_SIZE && videoAccessOrder.length > 0) {
      const oldestIndex = videoAccessOrder.findIndex((url) => (activeVideoRequests.get(url) ?? 0) === 0);
      if (oldestIndex < 0) return;
      const [oldest] = videoAccessOrder.splice(oldestIndex, 1);
      if (oldest) releaseVideo(oldest);
    }
  }

  function retainActiveVideo(url: string) {
    activeVideoRequests.set(url, (activeVideoRequests.get(url) ?? 0) + 1);
  }

  function releaseActiveVideo(url: string) {
    const next = (activeVideoRequests.get(url) ?? 1) - 1;
    if (next > 0) {
      activeVideoRequests.set(url, next);
    } else {
      activeVideoRequests.delete(url);
    }
  }

  // ── Image loading ───────────────────────────────────────
  async function loadImage(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
    // Try with CORS first, fall back to no-CORS canvas draw
    const bitmap = await tryLoadImageCors(url, signal);
    if (bitmap) return bitmap;
    if (signal.aborted) return null;
    return tryLoadImageNoCors(url, signal);
  }

  async function tryLoadImageCors(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        img.onload = null;
        img.onerror = null;
        img.src = "";
      };
      const onAbort = () => { cleanup(); resolve(null); };
      const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);
      signal.addEventListener("abort", onAbort, { once: true });

      img.onload = async () => {
        try {
          const bitmap = await createImageBitmap(img);
          cleanup();
          if (signal.aborted) {
            bitmap.close();
            resolve(null);
          } else {
            resolve(bitmap);
          }
        } catch {
          cleanup();
          resolve(null);
        }
      };
      img.onerror = () => { cleanup(); resolve(null); };
      img.src = url;
    });
  }

  // Fallback: load without CORS, draw to canvas (tainted but still renders)
  async function tryLoadImageNoCors(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const img = new Image();
      // No crossOrigin — avoids CORS error at the cost of tainting canvas
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        img.onload = null;
        img.onerror = null;
        img.src = "";
      };
      const onAbort = () => { cleanup(); resolve(null); };
      const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);
      signal.addEventListener("abort", onAbort, { once: true });

      img.onload = async () => {
        try {
          // createImageBitmap works on the img element directly
          const bitmap = await createImageBitmap(img);
          cleanup();
          if (signal.aborted) {
            bitmap.close();
            resolve(null);
          } else {
            resolve(bitmap);
          }
        } catch {
          cleanup();
          resolve(null);
        }
      };
      img.onerror = () => { cleanup(); resolve(null); };
      img.src = url;
    });
  }

  // ── Video frame extraction ──────────────────────────────
  function getOrCreateVideo(url: string): HTMLVideoElement {
    let video = videoPool.get(url);
    if (video) {
      touchVideo(url);
      return video;
    }
    video = document.createElement("video");
    if (shouldUseAnonymousVideoFrameCors(url, env.origin)) video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    videoPool.set(url, video);
    touchVideo(url);
    return video;
  }

  async function extractFrame(url: string, time: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    if (signal.aborted) return null;
    const video = getOrCreateVideo(url);
    retainActiveVideo(url);

    return new Promise((resolve) => {
      let settled = false;

      function cleanup() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        releaseActiveVideo(url);
        pruneVideoPool();
      }

      const onSeeked = async () => {
        try {
          const w = Math.min(video.videoWidth || 160, 160);
          const h = Math.min(video.videoHeight || 90, 90);

          if (typeof OffscreenCanvas !== "undefined") {
            const offscreen = new OffscreenCanvas(w, h);
            const octx = offscreen.getContext("2d");
            if (!octx) { cleanup(); resolve(null); return; }
            octx.drawImage(video, 0, 0, w, h);
            const bitmap = await createImageBitmap(offscreen);
            cleanup();
            if (signal.aborted) {
              bitmap.close();
              resolve(null);
            } else {
              resolve(bitmap);
            }
          } else {
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const cctx = canvas.getContext("2d");
            if (!cctx) { cleanup(); resolve(null); return; }
            cctx.drawImage(video, 0, 0, w, h);
            const bitmap = await createImageBitmap(canvas);
            cleanup();
            if (signal.aborted) {
              bitmap.close();
              resolve(null);
            } else {
              resolve(bitmap);
            }
          }
        } catch {
          cleanup();
          resolve(null);
        }
      };

      const onError = () => {
        cleanup();
        resolve(null);
      };
      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      const onLoadedMetadata = () => {
        if (signal.aborted) {
          onAbort();
          return;
        }
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = time;
      };

      const timeout = window.setTimeout(() => { cleanup(); resolve(null); }, 5000);
      signal.addEventListener("abort", onAbort, { once: true });

      if (video.readyState >= 1) {
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = time;
      } else {
        video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
        video.addEventListener("error", onError, { once: true });
      }
    });
  }

  return {
    get(url: string, time: number): ImageBitmap | undefined {
      const key = makeKey(url, time);
      const bitmap = cache.get(key);
      if (bitmap) touch(key);
      return bitmap;
    },

    request(url: string, times: number[]) {
      const isImageThumbnail = isImageUrl(url);

      // Per-time loader: <img> for images, <video>-seek for video. Used directly
      // for images and as the graceful fallback when WebCodecs decoding is
      // unavailable or declines a URL.
      const enqueuePerTime = (subTimes: number[]) => {
        for (const time of subTimes) {
          const key = makeKey(url, time);
          if (cache.has(key) || pending.has(key)) continue;
          if (pending.size >= MAX_CONCURRENT_THUMBNAIL_REQUESTS) return;
          const controller = new AbortController();
          pending.set(key, {
            url,
            cancel: () => controller.abort(),
          });

          const resolvedUrl = env.resolveMediaUrl(url);
          // Choose loader based on URL type
          const loader = isImageThumbnail
            ? loadImage(resolvedUrl, controller.signal)
            : extractFrame(resolvedUrl, time, controller.signal);

          loader.then((bitmap) => {
            pending.delete(key);
            if (bitmap && !controller.signal.aborted) {
              cache.set(key, bitmap);
              touch(key);
              evict();
              onUpdate?.();
            } else if (bitmap) {
              bitmap.close();
            }
          });
        }
      };

      // Fast path: decode all needed frames for a video URL in a single
      // hardware-accelerated WebCodecs pass. On unsupported codec / load error /
      // mid-stream failure it falls back per-URL to the <video>-seek path.
      const isImageThumbnailVideo = !isImageThumbnail;
      if (isImageThumbnailVideo && isWebCodecsFrameDecodeSupported()) {
        const needTimes = times.filter((time) => {
          const key = makeKey(url, time);
          return !cache.has(key) && !pending.has(key);
        });
        if (needTimes.length === 0) return;
        if (pending.size >= MAX_CONCURRENT_THUMBNAIL_REQUESTS) return;

        const controller = new AbortController();
        const batchKeys = needTimes.map((time) => makeKey(url, time));
        for (const key of batchKeys) {
          pending.set(key, { url, cancel: () => controller.abort() });
        }

        decodeFramesAtTimes(url, needTimes, controller.signal, (time, bitmap) => {
          const key = makeKey(url, time);
          pending.delete(key);
          if (controller.signal.aborted) {
            bitmap.close();
            return;
          }
          cache.set(key, bitmap);
          touch(key);
          evict();
          onUpdate?.();
        }, env.resolveMediaUrl)
          .then((handled) => {
            for (const key of batchKeys) pending.delete(key);
            if (!handled && !controller.signal.aborted) enqueuePerTime(needTimes);
          })
          .catch(() => {
            for (const key of batchKeys) pending.delete(key);
            if (!controller.signal.aborted) enqueuePerTime(needTimes);
          });
        return;
      }

      enqueuePerTime(times);
    },

    cancelUnused(keepUrls: Set<string>) {
      for (const [key, request] of pending) {
        if (!keepUrls.has(request.url)) {
          request.cancel();
          pending.delete(key);
        }
      }
      releaseUnusedInputs(keepUrls);
    },

    get onUpdate() { return onUpdate; },
    set onUpdate(fn: (() => void) | null) { onUpdate = fn; },
  };
}

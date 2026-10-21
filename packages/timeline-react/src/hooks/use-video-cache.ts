"use client";

// Blob-cache helpers for editor video previews without cross-origin console noise.
import { useCallback, useEffect } from "react";
import { useDocumentVisible } from "./use-document-visible";
import type { MediaEnvironment } from "@opennan/timeline-media";
import { useTimelineMedia } from "./use-timeline-media";

// Module-level singleton shared across all components
const blobCache = new Map<string, string>(); // original/proxy URL -> blob URL
const blobCacheOwners = new Map<string, string>(); // cache key -> original URL
const accessOrder: string[] = []; // original URLs in least-to-most-recent order
const MAX_BLOB_CACHE = 30; // max cached blob URLs to prevent memory bloat
const MAX_CONCURRENT_BLOB_PRELOADS = 3;
const fetching = new Map<string, AbortController>();

// Blob-caching a video downloads the whole file up front. That is worth it for
// the short clips this cache exists for, but a full source video costs tens of
// MB on every editor open and is too big for the browser's HTTP cache to keep,
// so it downloads again next time. Anything above this streams by range through
// the video element instead.
const MAX_BLOB_PRELOAD_BYTES = 8 * 1024 * 1024;

function isCacheableVideoPreloadResponse(response: Response): boolean {
  if (!response.ok) return false;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BLOB_PRELOAD_BYTES) return false;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType) return true;
  return contentType.startsWith("video/") || contentType === "application/octet-stream";
}

export function shouldPreloadVideoBlob(url: string, media: MediaEnvironment): boolean {
  return media.shouldPreloadBlob?.(url) ?? false;
}

export function abortVideoBlobPreloads(media: MediaEnvironment, urls?: (string | null | undefined)[]) {
  const targets = urls
    ? urls.filter((url): url is string => Boolean(url)).map((url) => media.resolveMediaUrl(url))
    : [...fetching.keys()];
  for (const fetchKey of targets) {
    const controller = fetching.get(fetchKey);
    if (!controller) continue;
    controller.abort();
    fetching.delete(fetchKey);
  }
}

function touchBlobCacheEntry(cacheKey: string) {
  const ownerUrl = blobCacheOwners.get(cacheKey) ?? cacheKey;
  const existingIndex = accessOrder.indexOf(ownerUrl);
  if (existingIndex >= 0) accessOrder.splice(existingIndex, 1);
  accessOrder.push(ownerUrl);
}

function evictBlobCacheEntry(ownerUrl: string) {
  const oldBlob = blobCache.get(ownerUrl);
  if (oldBlob) URL.revokeObjectURL(oldBlob);
  for (const [key, owner] of [...blobCacheOwners]) {
    if (owner !== ownerUrl) continue;
    blobCache.delete(key);
    blobCacheOwners.delete(key);
  }
  blobCache.delete(ownerUrl);
}

function pruneBlobCache() {
  while (accessOrder.length > MAX_BLOB_CACHE) {
    const oldest = accessOrder.shift();
    if (oldest) evictBlobCacheEntry(oldest);
  }
}

export function useVideoCache() {
  const media = useTimelineMedia();
  const docVisible = useDocumentVisible();

  useEffect(() => {
    if (!docVisible) abortVideoBlobPreloads(media);
  }, [docVisible, media]);

  const cachedUrl = useCallback((url: string | null | undefined): string | undefined => {
    if (!url) return undefined;
    const previewUrl = media.resolveMediaUrl(url);
    const blobUrl = blobCache.get(url) || blobCache.get(previewUrl);
    if (blobUrl) touchBlobCacheEntry(url);
    return blobUrl || previewUrl;
  }, [media]);

  const isCached = useCallback((url: string): boolean => {
    const previewUrl = media.resolveMediaUrl(url);
    return blobCache.has(url) || blobCache.has(previewUrl);
  }, [media]);

  /** Preload video URLs — fetch as blob once, reuse blob: URL forever (no re-download) */
  const preload = useCallback((urls: (string | null | undefined)[]) => {
    if (!docVisible) return;
    let availableSlots = MAX_CONCURRENT_BLOB_PRELOADS - fetching.size;
    for (const url of urls) {
      if (availableSlots <= 0) break;
      if (!url) continue;
      const previewUrl = media.resolveMediaUrl(url);
      const fetchKey = previewUrl;
      if (!shouldPreloadVideoBlob(url, media) || fetching.has(fetchKey)) continue;
      if (blobCache.has(url) || blobCache.has(previewUrl)) {
        touchBlobCacheEntry(url);
        continue;
      }
      const controller = new AbortController();
      fetching.set(fetchKey, controller);
      availableSlots -= 1;
      fetch(previewUrl, { signal: controller.signal })
        .then((r) => {
          if (controller.signal.aborted) return null;
          if (!isCacheableVideoPreloadResponse(r)) {
            // Headers are in but the body is not. Cancel it explicitly so an
            // oversized file stops transferring instead of streaming to nowhere.
            void r.body?.cancel().catch(() => {});
            return null;
          }
          return r.blob();
        })
        .then((blob) => {
          if (!blob) return;
          if (controller.signal.aborted) return;
          const blobUrl = URL.createObjectURL(blob);
          blobCache.set(url, blobUrl);
          blobCache.set(previewUrl, blobUrl);
          blobCacheOwners.set(url, url);
          blobCacheOwners.set(previewUrl, url);
          touchBlobCacheEntry(url);
          pruneBlobCache();
          // No notifyAll() — video elements load either blob or original URL,
          // no re-render needed. cachedUrl() returns blob URL on next call.
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // CORS not available — video element will load directly (still works, just no blob cache)
        })
        .finally(() => {
          if (fetching.get(fetchKey) === controller) fetching.delete(fetchKey);
        });
    }
  }, [docVisible, media]);

  const abortPreloads = useCallback((urls?: (string | null | undefined)[]) => {
    abortVideoBlobPreloads(media, urls);
  }, [media]);

  return { cachedUrl, preload, abortPreloads, isCached };
}

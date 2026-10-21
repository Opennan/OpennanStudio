// Unit coverage for timeline thumbnail loader URL policies.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThumbnailCache, shouldUseAnonymousVideoFrameCors } from "./thumbnail-generator";

describe("shouldUseAnonymousVideoFrameCors", () => {
  it("skips OpenNAN CDN videos so thumbnail extraction does not create failed CORS media requests", () => {
    expect(
      shouldUseAnonymousVideoFrameCors(
        "https://cdn.opennan.com/breakdowns/project/scene.mp4",
        "http://localhost:3001",
      ),
    ).toBe(false);
  });

  it("allows same-origin video frame extraction", () => {
    expect(shouldUseAnonymousVideoFrameCors("/media/scene.mp4", "http://localhost:3001")).toBe(true);
    expect(shouldUseAnonymousVideoFrameCors("http://localhost:3001/media/scene.mp4", "http://localhost:3001")).toBe(true);
  });

  it("skips blob and data URLs because they are already browser-local resources", () => {
    expect(shouldUseAnonymousVideoFrameCors("blob:http://localhost:3001/abc", "http://localhost:3001")).toBe(false);
    expect(shouldUseAnonymousVideoFrameCors("data:video/mp4;base64,AAAA", "http://localhost:3001")).toBe(false);
  });
});

describe("createThumbnailCache media cleanup", () => {
  it("loads thumbnail media through the preview URL resolver while keeping original URLs as cache keys", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");
    const requestBlock = source.slice(
      source.indexOf("request(url: string, times: number[])"),
      source.indexOf("get onUpdate()"),
    );

    expect(source).toContain('import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "./media-environment";');
    expect(requestBlock).toContain("const resolvedUrl = env.resolveMediaUrl(url);");
    expect(requestBlock).toContain("isImageUrl(url)");
    expect(requestBlock).toContain("loadImage(resolvedUrl, controller.signal)");
    expect(requestBlock).toContain("extractFrame(resolvedUrl, time, controller.signal)");
    expect(requestBlock).toContain("const key = makeKey(url, time);");
    expect(requestBlock).toContain("url,");
  });

  it("extracts video-frame thumbnails from proxied local backend media through the same-origin preview proxy", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");
    const requestBlock = source.slice(
      source.indexOf("request(url: string, times: number[])"),
      source.indexOf("get onUpdate()"),
    );

    expect(source).toContain('import { IDENTITY_MEDIA_ENVIRONMENT, type MediaEnvironment } from "./media-environment";');
    expect(requestBlock).toContain("const isImageThumbnail = isImageUrl(url);");
    expect(requestBlock).not.toContain("isProxiedLocalBackendMedia(resolvedUrl)");
    expect(requestBlock).not.toContain("pending.delete(key);\n          continue;");
    expect(requestBlock).toContain("extractFrame(resolvedUrl, time, controller.signal)");
    expect(requestBlock).toContain("isImageThumbnail");
  });

  it("classifies image URLs with media fragments as images instead of video frames", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");

    expect(source).toContain("const IMAGE_EXTS = /\\.(jpe?g|png|webp|gif|avif|bmp|svg)([?#]|$)/i;");
  });

  it("cleans up image and video thumbnail loader listeners on settle", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");

    expect(source).toContain("img.onload = null;");
    expect(source).toContain("img.onerror = null;");
    expect(source).toContain('img.src = "";');
    expect(source).toContain("function cleanup() {");
    expect(source).toContain("video.removeEventListener(\"loadedmetadata\", onLoadedMetadata);");
    expect(source).toContain("video.removeEventListener(\"seeked\", onSeeked);");
    expect(source).toContain("video.removeEventListener(\"error\", onError);");
    expect(source).toContain("const timeout = window.setTimeout(() => { cleanup(); resolve(null); }, 5000);");
  });

  it("bounds pooled video elements so long sessions do not retain every decoder", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");

    expect(source).toContain("const MAX_VIDEO_POOL_SIZE = 16;");
    expect(source).toContain("const videoAccessOrder: string[] = [];");
    expect(source).toContain("function touchVideo(url: string)");
    expect(source).toContain("function releaseVideo(url: string)");
    expect(source).toContain("video.pause();");
    expect(source).toContain('video.removeAttribute("src");');
    expect(source).toContain("video.load();");
    expect(source).toContain("function pruneVideoPool()");
    expect(source).toContain("while (videoPool.size > MAX_VIDEO_POOL_SIZE && videoAccessOrder.length > 0)");
    expect(source).toContain("releaseVideo(oldest);");
    expect(source).toContain("touchVideo(url);");
    expect(source).toContain("pruneVideoPool();");
  });

  it("caps concurrent thumbnail image and video extraction work", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");
    const requestBlock = source.slice(
      source.indexOf("request(url: string, times: number[])"),
      source.indexOf("get onUpdate()"),
    );

    expect(source).toContain("const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 4;");
    expect(requestBlock).toContain("if (pending.size >= MAX_CONCURRENT_THUMBNAIL_REQUESTS) return;");
    expect(requestBlock).toContain("pending.set(key, {");
    expect(requestBlock).toContain("pending.delete(key);");
  });

  it("cancels pending thumbnail extraction outside the active timeline window", () => {
    const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");

    expect(source).toContain("type PendingThumbnailRequest = {");
    expect(source).toContain("cancel: () => void;");
    expect(source).toContain("const pending = new Map<string, PendingThumbnailRequest>();");
    expect(source).toContain("cancelUnused(keepUrls: Set<string>)");
    expect(source).toContain("if (!keepUrls.has(request.url)) {");
    expect(source).toContain("request.cancel();");
    expect(source).toContain("pending.delete(key);");
  });
});

describe("createThumbnailCache media environment", () => {
  it("loads image thumbnails through env.resolveMediaUrl and keys the cache by the original url", () => {
    class FakeImage {
      static srcs: string[] = [];
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) FakeImage.srcs.push(value);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const cache = createThumbnailCache({ resolveMediaUrl: (url) => `resolved:${url}` });

    cache.request("https://cdn.test/a.png", [0]);

    expect(FakeImage.srcs).toContain("resolved:https://cdn.test/a.png");
    expect(cache.get("https://cdn.test/a.png", 0)).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

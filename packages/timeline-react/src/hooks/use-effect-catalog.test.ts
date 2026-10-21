// Source-level coverage for effect catalog cache hydration stability.
import { renderHook, waitFor } from "@testing-library/react";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEffectCatalog } from "../effects/effect-catalog-source";
import type { EffectDef } from "@opennan/timeline-core";
import { __clearEffectCatalogCacheForTests, preloadEffectCatalog, useEffectCatalog } from "./use-effect-catalog";

vi.mock("../effects/effect-catalog-source", () => ({
    fetchEffectCatalog: vi.fn(),
}));

const visibilityMock = { visible: true };

vi.mock("./use-document-visible", () => ({
    useDocumentVisible: () => visibilityMock.visible,
}));

describe("useEffectCatalog source contract", () => {
    beforeEach(() => {
        vi.mocked(fetchEffectCatalog).mockReset();
        __clearEffectCatalogCacheForTests();
        visibilityMock.visible = true;
    });

    it("fetches only the requested catalog kind", async () => {
        vi.mocked(fetchEffectCatalog).mockResolvedValue([]);

        const hook = renderHook(() => useEffectCatalog("transition"));
        await waitFor(() => expect(fetchEffectCatalog).toHaveBeenCalledTimes(1));

        expect(fetchEffectCatalog).toHaveBeenCalledWith("transition", {
            signal: expect.any(AbortSignal),
        });
        hook.unmount();
    });

    it("preloads a catalog into the shared cache before a tab is mounted", async () => {
        const catalog: EffectDef[] = [{ id: "blur", kind: "effect", name: "Blur", category: "Basic", params: [], glsl: "", thumbnail: null, ownerScope: "system" }];
        vi.mocked(fetchEffectCatalog).mockResolvedValue(catalog);

        await expect(preloadEffectCatalog("effect")).resolves.toEqual(catalog);

        const hook = renderHook(() => useEffectCatalog("effect"));

        expect(fetchEffectCatalog).toHaveBeenCalledTimes(1);
        expect(hook.result.current.items).toEqual(catalog);
        expect(hook.result.current.loading).toBe(false);
        hook.unmount();
    });

    it("aborts in-flight catalog fetches when the last hook consumer unmounts", async () => {
        vi.mocked(fetchEffectCatalog).mockImplementation(() => new Promise(() => {}));

        const hook = renderHook(() => useEffectCatalog("effect"));
        await waitFor(() => expect(fetchEffectCatalog).toHaveBeenCalledTimes(1));
        const signal = vi.mocked(fetchEffectCatalog).mock.calls[0]?.[1]?.signal;

        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);

        hook.unmount();

        expect(signal?.aborted).toBe(true);
    });

    it("defers catalog fetches while the document is hidden", async () => {
        vi.mocked(fetchEffectCatalog).mockResolvedValue([]);
        visibilityMock.visible = false;

        const hook = renderHook(() => useEffectCatalog("effect"));
        await Promise.resolve();

        expect(hook.result.current.loading).toBe(false);
        expect(fetchEffectCatalog).not.toHaveBeenCalled();

        visibilityMock.visible = true;
        hook.rerender();

        await waitFor(() => expect(fetchEffectCatalog).toHaveBeenCalledTimes(1));
        hook.unmount();
    });
});

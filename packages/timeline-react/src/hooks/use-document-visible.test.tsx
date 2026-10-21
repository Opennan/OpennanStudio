// Behavior coverage for the shared document visibility subscription.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentVisible } from "./use-document-visible";

function mockVisibilityState(initial: DocumentVisibilityState = "visible") {
  let value = initial;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  return {
    set: (next: DocumentVisibilityState) => {
      value = next;
    },
  };
}

describe("useDocumentVisible", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one visibilitychange listener across mounted consumers", () => {
    mockVisibilityState("visible");
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const first = renderHook(() => useDocumentVisible());
    const second = renderHook(() => useDocumentVisible());

    expect(addSpy.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);

    first.unmount();
    expect(removeSpy.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(0);

    second.unmount();
    expect(removeSpy.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);
  });

  it("updates every mounted consumer when the document visibility changes", () => {
    const visibility = mockVisibilityState("visible");
    const first = renderHook(() => useDocumentVisible());
    const second = renderHook(() => useDocumentVisible());

    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);

    act(() => {
      visibility.set("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);

    first.unmount();
    second.unmount();
  });
});

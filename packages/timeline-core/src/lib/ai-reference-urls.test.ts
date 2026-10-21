// Unit tests for merging multi-select AI reference-image uploads.
import { describe, expect, it } from "vitest";
import { mergeAiReferenceUrls } from "./ai-reference-urls";

describe("mergeAiReferenceUrls", () => {
  it("appends every newly uploaded url to the existing list", () => {
    expect(mergeAiReferenceUrls(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("preserves order and dedupes urls already present", () => {
    expect(mergeAiReferenceUrls(["a", "b"], ["b", "c", "a"])).toEqual(["a", "b", "c"]);
  });

  it("drops empty/falsy entries", () => {
    expect(mergeAiReferenceUrls(["a"], ["", "b"])).toEqual(["a", "b"]);
  });

  it("returns the existing list unchanged when nothing new was uploaded", () => {
    expect(mergeAiReferenceUrls(["a"], [])).toEqual(["a"]);
  });
});

import { createTranslator, mergeMessages } from "./format";

describe("createTranslator", () => {
  const t = createTranslator(mergeMessages(), "en");

  it("returns English defaults", () => {
    expect(t("timeline", "undo")).toBe("Undo");
    expect(t("canvasTimeline", "editImage")).toBe("Edit image");
  });

  it("formats ICU plurals", () => {
    expect(t("timeline", "sceneCount", { n: 1 })).toBe("1 scene");
    expect(t("timeline", "sceneCount", { n: 3 })).toBe("3 scenes");
  });

  it("falls back to English for keys a host locale lacks, then to ns.key", () => {
    const th = createTranslator(mergeMessages({ timeline: { undo: "เลิกทำ" } }), "th");
    expect(th("timeline", "undo")).toBe("เลิกทำ");
    expect(th("timeline", "redo")).toBe("Redo");
    expect(th("timeline", "noSuchKey")).toBe("timeline.noSuchKey");
  });

  it("returns the raw string when formatting fails", () => {
    const broken = createTranslator(mergeMessages({ timeline: { undo: "Undo {" } }), "en");
    expect(broken("timeline", "undo", { n: 1 })).toBe("Undo {");
  });
});

// packages/timeline-core/src/design/fixture.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLayerDesign } from "./validate";
import { describeDesign } from "./summary";

it("the playground fixture is a valid design whose texts all draw from original lettering", () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../apps/playground/public/layer-demo/design.json"), "utf8"));
    const d = parseLayerDesign(raw);
    const s = describeDesign(d);
    expect(s.layers.filter((l) => l.kind === "text")).toHaveLength(15);
    expect(s.layers.every((l) => l.kind !== "text" || l.lettering === "original")).toBe(true);
    expect(s.groups.length).toBeGreaterThanOrEqual(8);
});

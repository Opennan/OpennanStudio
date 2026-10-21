// Unit coverage for selected-clip inspector crop guide contracts.
import { describe, expect, it } from "vitest";
import { buildRemotionParamControls } from "./clip-properties-remotion";
import { registerRemotionAddon } from "../remotion/registry";
import templates from "./__fixtures__/templates.json";

beforeAll(() => {
  registerRemotionAddon({ templates: templates as Parameters<typeof registerRemotionAddon>[0]["templates"] });
});

describe("buildRemotionParamControls", () => {
    it("returns every template param with its default value when no props are stored", () => {
        const controls = buildRemotionParamControls("animated-title", null);

        expect(controls.map((c) => c.key)).toEqual(["title", "subtitle", "color", "accentColor", "align", "speed"]);
        const title = controls.find((c) => c.key === "title");
        expect(title).toMatchObject({ label: "Title", type: "text", value: "Your Title" });
        const speed = controls.find((c) => c.key === "speed");
        expect(speed?.type).toBe("number");
        expect(speed?.value).toBe(1);
        const align = controls.find((c) => c.key === "align");
        expect(align?.type).toBe("select");
        expect(Array.isArray(align?.options)).toBe(true);
    });

    it("merges stored props over template defaults", () => {
        const controls = buildRemotionParamControls(
            "animated-title",
            JSON.stringify({ title: "Hello", speed: 2 }),
        );

        expect(controls.find((c) => c.key === "title")?.value).toBe("Hello");
        expect(controls.find((c) => c.key === "speed")?.value).toBe(2);
        // Untouched params keep their defaults.
        expect(controls.find((c) => c.key === "color")?.value).toBe("#ffffff");
    });

    it("flags unparseable stored json-type values while preserving the raw string", () => {
        const controls = buildRemotionParamControls(
            "bar-chart",
            JSON.stringify({ data: "[{broken json" }),
        );

        const data = controls.find((c) => c.key === "data");
        expect(data?.type).toBe("json");
        expect(data?.invalidJson).toBe(true);
        expect(data?.value).toBe("[{broken json");
    });

    it("promotes tabular json data to an objectArray control", () => {
        const controls = buildRemotionParamControls("bar-chart", null);

        const data = controls.find((c) => c.key === "data");
        expect(data?.type).toBe("objectArray");
        expect(data?.invalidJson).toBeFalsy();
        expect(data?.arrayAsString).toBe(true);
        expect(data?.columns).toEqual([
            { key: "label", type: "text" },
            { key: "value", type: "number" },
        ]);
        expect(Array.isArray(data?.value)).toBe(true);
    });

    it("promotes a colour list to a colorArray control", () => {
        const controls = buildRemotionParamControls(
            "confetti-burst",
            JSON.stringify({ colors: '["#ffffff", "#000000"]' }),
        );

        const colors = controls.find((c) => c.key === "colors");
        expect(colors?.type).toBe("colorArray");
        expect(colors?.arrayAsString).toBe(true);
        expect(colors?.value).toEqual(["#ffffff", "#000000"]);
    });

    it("leaves nested or ragged json arrays as raw json", () => {
        const nested = buildRemotionParamControls(
            "bar-chart",
            JSON.stringify({ data: '[{"label": "A", "value": {"n": 1}}]' }),
        ).find((c) => c.key === "data");
        expect(nested?.type).toBe("json");

        const ragged = buildRemotionParamControls(
            "bar-chart",
            JSON.stringify({ data: '[{"label": "A", "value": 1}, {"label": "B"}]' }),
        ).find((c) => c.key === "data");
        expect(ragged?.type).toBe("json");
    });

    it("returns an empty list for unknown or missing templates", () => {
        expect(buildRemotionParamControls("no-such-template", null)).toEqual([]);
        expect(buildRemotionParamControls(null, null)).toEqual([]);
        expect(buildRemotionParamControls(undefined, "{}")).toEqual([]);
    });

    it("falls back to defaults when the stored props json is unparseable", () => {
        const controls = buildRemotionParamControls("animated-title", "{not json");

        expect(controls.find((c) => c.key === "title")?.value).toBe("Your Title");
    });
});

import { TEXT_FONTS, fontById, fontByFamily, fontFacesForStyle, fontStack, nearestWeight, primaryFontFamily } from "./fonts";

describe("bundled fonts", () => {
    it("lists the twelve OFL families with their fontsource packages and weights", () => {
        expect(TEXT_FONTS.map((f) => [f.family, f.weights.join("/")])).toEqual([
            ["Inter", "400/700/900"], ["Montserrat", "400/700/900"], ["Poppins", "400/600/800"], ["Bebas Neue", "400"],
            ["Anton", "400"], ["Oswald", "400/700"], ["Playfair Display", "400/700"], ["Lobster", "400"], ["Pacifico", "400"],
            ["Caveat", "400/700"], ["Dancing Script", "400/700"], ["Bangers", "400"],
        ]);
        expect(fontById("bebas_neue")?.packageName).toBe("@fontsource/bebas-neue");
        expect(fontById("dancing_script")?.category).toBe("handwritten");
        expect(fontById("playfair_display")?.category).toBe("serif");
        expect(new Set(TEXT_FONTS.map((f) => f.id)).size).toBe(12);
        expect(fontById("comic_sans")).toBeUndefined();
    });

    it("builds font stacks with category fallbacks", () => {
        expect(fontStack("Inter")).toBe('Inter, "Helvetica Neue", Arial, sans-serif');
        expect(fontStack("Bebas Neue")).toBe('"Bebas Neue", Impact, "Arial Narrow", sans-serif');
        expect(fontStack("Playfair Display")).toMatch(/^"Playfair Display", .*serif$/);
        expect(fontStack("Caveat")).toMatch(/cursive$/);
        expect(fontStack("My Font")).toBe('"My Font", sans-serif');
    });

    it("finds families from CSS font-family lists", () => {
        expect(primaryFontFamily('"Bebas Neue", Impact, sans-serif')).toBe("Bebas Neue");
        expect(primaryFontFamily("  'Lobster' , cursive")).toBe("Lobster");
        expect(fontByFamily("bebas neue")?.id).toBe("bebas_neue");
        expect(fontByFamily("Helvetica")).toBeUndefined();
    });

    it("picks the nearest bundled weight", () => {
        const poppins = fontById("poppins")!;
        expect(nearestWeight(poppins, 700)).toBe(800);
        expect(nearestWeight(poppins, "bold")).toBe(800);
        expect(nearestWeight(poppins, "normal")).toBe(400);
        expect(nearestWeight(poppins, "500")).toBe(600);
        expect(nearestWeight(fontById("inter")!, 800)).toBe(900);
        expect(nearestWeight(fontById("anton")!, 900)).toBe(400);
        expect(nearestWeight(fontById("inter")!, "garbage")).toBe(400);
    });

    it("reports the faces a host must load before drawing a style", () => {
        expect(fontFacesForStyle(null)).toEqual([{ family: "Inter", weight: 700, style: "normal" }]);
        expect(fontFacesForStyle(JSON.stringify({ fontFamily: fontStack("Montserrat"), fontWeight: "900", fontStyle: "italic" })))
            .toEqual([{ family: "Montserrat", weight: 900, style: "italic" }]);
        expect(fontFacesForStyle(JSON.stringify({ fontFamily: "Georgia, serif" }))).toEqual([]);
        expect(fontFacesForStyle("{bad")).toEqual([{ family: "Inter", weight: 700, style: "normal" }]);
    });
});

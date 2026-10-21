import { EQ_PIXEL_FORMATS, GPL_ONLY_FILTERS, eqLookup, gplFiltersIn, pinEqFormats } from "./lgpl-filters";
import { compileExport } from "./compile";
import { COMPILE_OPTIONS, FEATURE_TIMELINES } from "./compile/test-helpers";

describe("GPL_ONLY_FILTERS", () => {
    it("lists FFmpeg 7.1's gpl-only filters", () => {
        expect(GPL_ONLY_FILTERS).toHaveLength(34);
        for (const name of ["eq", "perspective", "boxblur", "hqdn3d", "delogo", "smartblur", "stereo3d"]) expect(GPL_ONLY_FILTERS).toContain(name);
        for (const name of ["lutyuv", "avgblur", "geq", "rotate", "colorbalance"]) expect(GPL_ONLY_FILTERS).not.toContain(name);
    });
});

describe("gplFiltersIn", () => {
    it("finds filter names at chain starts only", () => {
        expect(gplFiltersIn("[0:v]scale=2:2,eq=contrast=2[a];[a]perspective=x0=1[b]")).toEqual(["eq", "perspective"]);
        expect(gplFiltersIn("[0:v]geq=lum='lum(X,Y)':a='eq(1,1)'[a]")).toEqual([]);
        expect(gplFiltersIn("[0:v]lutyuv=y='clip(val,0,255)'[a]")).toEqual([]);
    });
});

describe("eqLookup", () => {
    it("is the identity for neutral parameters", () => {
        expect(eqLookup({ brightness: 0, contrast: 1, saturation: 1 })).toBeNull();
    });

    it("reproduces eq's integer formula per plane and copies identity planes", () => {
        // contrast 1.2 -> C = 4915, B = (100*511)/200 - 128 - 153 = 255 - 281 = -26; chroma untouched (lutyuv's default would clip it)
        expect(eqLookup({ brightness: 0, contrast: 1.2, saturation: 1 })).toBe("lutyuv=y='clip(floor(val*4915/4096)-26,0,255)':u=val:v=val");
        // brightness 0.1 -> B = (110*511)/200 - 128 - 128 = 281 - 256 = 25 ; saturation 0.95 -> C = 3891, B = 255 - 128 - 121 = 6
        expect(eqLookup({ brightness: 0.1, contrast: 1, saturation: 0.95 }))
            .toBe("lutyuv=y='clip(floor(val*4096/4096)+25,0,255)':u='clip(floor(val*3891/4096)+6,0,255)':v='clip(floor(val*3891/4096)+6,0,255)'");
        expect(eqLookup({ brightness: 0, contrast: 1, saturation: 0.95 }))
            .toBe("lutyuv=y=val:u='clip(floor(val*3891/4096)+6,0,255)':v='clip(floor(val*3891/4096)+6,0,255)'");
    });

    it("rounds parameters to float like eq's av_clipf", () => {
        // brightness 0.03 is 0.0299999993 as a float: (int)(102.99999) = 102 -> B = 260 - 128 - 138 = -6 (not -3 from double math)
        expect(eqLookup({ brightness: 0.03, contrast: 1.08, saturation: 1.12 }))
            .toBe("lutyuv=y='clip(floor(val*4423/4096)-6,0,255)':u='clip(floor(val*4587/4096)-16,0,255)':v='clip(floor(val*4587/4096)-16,0,255)'");
    });

    it("clamps like eq (brightness ±1, saturation 0-3)", () => {
        expect(eqLookup({ brightness: 5, contrast: 1, saturation: 9 })).toBe(eqLookup({ brightness: 1, contrast: 1, saturation: 3 }));
    });
});

describe("pinEqFormats", () => {
    it("pins eq's 8-bit input formats once, before the first lookup", () => {
        expect(EQ_PIXEL_FORMATS).toBe("format=pix_fmts=yuv410p|yuv411p|yuv420p|yuva420p|yuv422p|yuva422p|yuv444p|yuva444p");
        expect(pinEqFormats(["crop=w=1", "lutyuv=y=val", "avgblur=sizeX=2:sizeY=2", "lutyuv=u=val"]))
            .toEqual(["crop=w=1", EQ_PIXEL_FORMATS, "lutyuv=y=val", "avgblur=sizeX=2:sizeY=2", "lutyuv=u=val"]);
        expect(pinEqFormats(["crop=w=1", "hflip"])).toEqual(["crop=w=1", "hflip"]);
    });
});

describe("compiled graphs", () => {
    // One synthetic timeline per feature group, built with the helpers compile.test.ts uses
    // (synthetic media facts, no ffmpeg): color, each visual preset, blur, each blend mode, chroma key,
    // crop/flip/rotate, keyframed scale/position/rotation/opacity, each motion preset, transitions, audio.
    it.each(FEATURE_TIMELINES)("%s uses no GPL-only filter", (_name, input) => {
        const plan = compileExport(input, { resolution: "720p" }, COMPILE_OPTIONS);
        expect(gplFiltersIn(plan.filterGraph)).toEqual([]);
    });
});

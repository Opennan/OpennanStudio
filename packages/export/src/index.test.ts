import * as exportApi from "./index";

describe("@opennan/export public API", () => {
    it("exposes compile, pipeline, encoders and session", () => {
        expect(exportApi.EXPORT_VERSION).toBe("0.8.0");
        for (const name of [
            "compileExport", "collectMediaUrls", "staticExportWarnings", "planRasterJobs", "createCanvasRasterizer", "encoderCandidates",
            "buildFfmpegArgs", "buildFrameArgs", "frameFilterScript", "exportTimeline", "createExportSession", "createExportFrameRenderer", "resolveOutputFormat",
            "parseProgressSeconds", "planGlPasses", "createRemoteRasterizer", "createRemoteGlFrameProcessor", "serveOverlayRasterizer", "serveGlFrameProcessor",
        ] as const) {
            expect(typeof exportApi[name]).toBe("function");
        }
        expect(exportApi.LGPL_H264_ENCODERS).toEqual(["h264_videotoolbox", "h264_mf", "h264_vaapi", "libopenh264"]);
        expect(new exportApi.ExportError("cancelled", "x").code).toBe("cancelled");
    });
});

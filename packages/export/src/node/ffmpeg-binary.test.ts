import { existsSync } from "node:fs";
import { chooseWorkingEncoder, listEncoders, parseFfmpegMajorVersion } from "./ffmpeg-binary";

const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";

describe("parseFfmpegMajorVersion", () => {
    it("reads release, n-prefixed, and git builds", () => {
        expect(parseFfmpegMajorVersion("ffmpeg version 7.1.1 Copyright (c) 2000-2025")).toBe(7);
        expect(parseFfmpegMajorVersion("ffmpeg version n6.0 Copyright")).toBe(6);
        expect(parseFfmpegMajorVersion("ffmpeg version N-112345-gabc Copyright")).toBe(99);
        expect(parseFfmpegMajorVersion("nonsense")).toBe(0);
    });
});

describe.skipIf(!existsSync(FFMPEG))("encoders of the local ffmpeg", () => {
    it("lists encoders and picks an LGPL one by default", async () => {
        expect(await listEncoders(FFMPEG)).toContain("mpeg4");
        const choice = await chooseWorkingEncoder(FFMPEG, { videoBitrateKbps: 1000, audioBitrateKbps: 128 });
        expect(choice.gpl).toBe(false);
    });
});

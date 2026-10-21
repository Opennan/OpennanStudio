import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddedConfiguration, lgplProblems } from "./check-ffmpeg-lgpl.mjs";

const LGPL_LICENSE = "ffmpeg is free software; you can redistribute it and/or\nmodify it under the terms of the GNU Lesser General Public\nLicense as published by the Free Software Foundation";
const GPL_LICENSE = "ffmpeg is free software; you can redistribute it and/or modify\nit under the terms of the GNU General Public License as published by";
const ENCODERS = " V....D h264_videotoolbox    VideoToolbox H.264 Encoder\n VF...D png                  PNG\n V....D gif                  GIF\n A....D aac                  AAC\n";
const LGPL_CONF = "configuration:\n    --prefix=/x\n    --disable-autodetect\n    --enable-videotoolbox\n    --enable-zlib\n    --disable-network";
const HOMEBREW_CONF = "configuration:\n    --prefix=/opt/homebrew\n    --enable-shared\n    --enable-gpl\n    --enable-libx264\n    --enable-libx265\n    --enable-videotoolbox";

test("passes the LGPL macOS build", () => {
    assert.deepEqual(lgplProblems({ buildconf: LGPL_CONF, license: LGPL_LICENSE, encoders: ENCODERS, platform: "darwin" }), []);
});

test("flags Homebrew's GPL build", () => {
    const problems = lgplProblems({ buildconf: HOMEBREW_CONF, license: GPL_LICENSE, encoders: ENCODERS, platform: "darwin" });
    assert.ok(problems.includes("built with --enable-gpl"));
    assert.ok(problems.some((p) => p.includes("libx264")));
    assert.ok(problems.some((p) => p.includes("Lesser")));
});

test("flags nonfree, version3 without its text, missing notices and encoders", () => {
    const problems = lgplProblems({ buildconf: "--enable-nonfree --enable-version3 --enable-libfdk-aac", license: LGPL_LICENSE, encoders: "", licenseText: "", sourceText: "", platform: "win32" });
    for (const expected of ["built with --enable-nonfree", "--enable-version3 needs the LGPL 3.0 text in LICENSE.txt", "LICENSE.txt is missing", "SOURCE.txt is missing", "no aac encoder", "no png encoder (preview frames)", "no gif encoder (GIF export)"]) {
        assert.ok(problems.includes(expected), expected);
    }
    assert.ok(problems.some((p) => p.includes("libfdk")));
    assert.ok(problems.some((p) => p.startsWith("no LGPL H.264 encoder")));
});

test("reads the configure line embedded in a binary", () => {
    const bytes = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("--prefix=/ffbuild/prefix --enable-version3 --enable-libopenh264"), Buffer.from([0, 9])]);
    assert.equal(embeddedConfiguration(bytes), "--prefix=/ffbuild/prefix --enable-version3 --enable-libopenh264");
    assert.equal(embeddedConfiguration(Buffer.from("nothing")), null);
});

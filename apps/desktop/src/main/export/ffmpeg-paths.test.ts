import path from "node:path";
import { resolveFfmpeg } from "./ffmpeg-paths";

const all = () => true;

describe("resolveFfmpeg", () => {
    it("uses only the bundled binary when packaged", () => {
        expect(resolveFfmpeg({ env: { OPENNAN_FFMPEG: "/gpl/ffmpeg", OPENNAN_FFPROBE: "/gpl/ffprobe" }, resourcesPath: "/r", appPath: "/a", platform: "darwin", arch: "arm64", isPackaged: true, exists: all }))
            .toEqual({ ffmpegPath: path.join("/r", "ffmpeg", "ffmpeg"), ffprobePath: path.join("/r", "ffmpeg", "ffprobe") });
    });

    it("takes the env pair in dev, else the fetched binaries", () => {
        expect(resolveFfmpeg({ env: { OPENNAN_FFMPEG: "/x/ffmpeg", OPENNAN_FFPROBE: "/x/ffprobe" }, resourcesPath: "/r", appPath: "/a", platform: "darwin", arch: "arm64", isPackaged: false, exists: all }))
            .toEqual({ ffmpegPath: "/x/ffmpeg", ffprobePath: "/x/ffprobe" });
        expect(resolveFfmpeg({ env: { OPENNAN_FFMPEG: "/x/ffmpeg" }, resourcesPath: "/r", appPath: "/a", platform: "win32", arch: "x64", isPackaged: false, exists: all }))
            .toEqual({ ffmpegPath: path.join("/a", "resources", "ffmpeg", "win32-x64", "ffmpeg.exe"), ffprobePath: path.join("/a", "resources", "ffmpeg", "win32-x64", "ffprobe.exe") });
    });

    it("is null when a binary is missing", () => {
        expect(resolveFfmpeg({ env: {}, resourcesPath: "/r", appPath: "/a", platform: "linux", arch: "x64", isPackaged: true, exists: (f) => f.endsWith("ffmpeg") })).toBeNull();
    });
});

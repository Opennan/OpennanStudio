import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROBE_GUARDS, createGuardedProbe } from "./probe";

const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

describe("guarded probe", () => {
    it("passes the export runner's protocol and format whitelists", async () => {
        const probe = vi.fn(async () => ({ durationSeconds: 1, hasVideo: true, hasAudio: false, width: 2, height: 2 }));
        await createGuardedProbe("/bin/ffprobe", probe)("/m/a.mp4");
        expect(probe).toHaveBeenCalledWith("/bin/ffprobe", "/m/a.mp4", undefined, PROBE_GUARDS);
        expect(PROBE_GUARDS).toContain("file,pipe");
    });

    it.skipIf(!fs.existsSync(FFPROBE))("refuses a manifest disguised as media", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-probe-"));
        const file = path.join(dir, "clip.mp4");
        fs.writeFileSync(file, "ffconcat version 1.0\nfile '/etc/hosts'\n");
        await expect(createGuardedProbe(FFPROBE)(file)).resolves.toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

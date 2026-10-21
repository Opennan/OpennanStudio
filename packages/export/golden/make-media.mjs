// Generates the golden fixture media with ffmpeg's built-in sources (deterministic, no downloads).
// VP9/Opus WebM so Playwright's Chromium (no H.264) can play it in the preview.
// Usage: node golden/make-media.mjs   (OPENNAN_FFMPEG overrides /opt/homebrew/bin/ffmpeg)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ffmpeg = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "media");
mkdirSync(dir, { recursive: true });

const run = (args) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const vp9 = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p"];
const opus = ["-c:a", "libopus", "-b:a", "96k"];

const outputs = {
    "clip-a.webm": () => run(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000", ...vp9, ...opus, "-shortest", path.join(dir, "clip-a.webm")]),
    "clip-b.webm": () => run(["-f", "lavfi", "-i", "smptebars=size=480x360:rate=25:duration=3", ...vp9, path.join(dir, "clip-b.webm")]),
    "tone.webm": () => run(["-f", "lavfi", "-i", "sine=frequency=660:duration=6:sample_rate=48000", "-ac", "2", ...opus, path.join(dir, "tone.webm")]),
    "sticker.png": () => run(["-f", "lavfi", "-i", "color=c=red:s=160x160,format=rgba,geq=r='255':g='128*X/W':b='0':a='if(lt(hypot(X-80,Y-80),70),255,0)'", "-frames:v", "1", "-update", "1", path.join(dir, "sticker.png")]),
    "image.png": () => run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1:duration=1", "-frames:v", "1", "-update", "1", path.join(dir, "image.png")]),
    // Export-only fixtures (never played by the preview, so any container works).
    "quadrants.png": () => run(["-f", "lavfi", "-i", "color=c=red:s=160x160,drawbox=x=80:y=0:w=80:h=80:color=0x00ff00:t=fill,drawbox=x=0:y=80:w=80:h=80:color=blue:t=fill,drawbox=x=80:y=80:w=80:h=80:color=white:t=fill", "-frames:v", "1", "-update", "1", path.join(dir, "quadrants.png")]),
    "keyed.png": () => run(["-f", "lavfi", "-i", "color=c=0x00ff00:s=160x160,drawbox=x=40:y=40:w=80:h=80:color=blue:t=fill", "-frames:v", "1", "-update", "1", path.join(dir, "keyed.png")]),
    "red.png": () => run(["-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", "-update", "1", path.join(dir, "red.png")]),
    // Frame N shows N as 7 binary bars (bar b white when bit b is set): survives lossy encoding exactly.
    "counter.mkv": () => run(["-f", "lavfi", "-i", "nullsrc=s=1920x1080:r=30:d=4,format=yuv420p,geq=lum='if(mod(floor(N/pow(2,floor(X*7/W))),2),235,16)':cb=128:cr=128", "-c:v", "ffv1", "-pix_fmt", "yuv420p", path.join(dir, "counter.mkv")]),
    "tone440.mkv": () => run(["-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", "-ac", "2", "-c:a", "flac", path.join(dir, "tone440.mkv")]),
    "shot-red.webm": () => run(["-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2", ...vp9, path.join(dir, "shot-red.webm")]),
    "shot-blue.webm": () => run(["-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=1", ...vp9, path.join(dir, "shot-blue.webm")]),
};

for (const [name, make] of Object.entries(outputs)) {
    if (!existsSync(path.join(dir, name))) make();
}
copyFileSync(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"), path.join(dir, "golden-font.ttf"));
console.log(`golden media ready in ${path.relative(process.cwd(), dir)}`);

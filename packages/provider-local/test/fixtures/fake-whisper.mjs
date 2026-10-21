// A stand-in for whisper-cli in tests: records its argv, prints progress, writes <-of>.json.
// FAKE_WHISPER_MODE: ok (default) | fail | hang | bad-json. FAKE_WHISPER_LOG: where argv goes.
import fs from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (process.env.FAKE_WHISPER_LOG) fs.writeFileSync(process.env.FAKE_WHISPER_LOG, JSON.stringify(args));
const mode = process.env.FAKE_WHISPER_MODE ?? "ok";
process.stdout.write("[00:00:00.000 --> 00:00:05.410]   And so, my fellow Americans\n");
for (const p of [0, 50, 100]) process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`);
if (mode === "fail") {
    process.stderr.write(`error: failed to load the model '${value("-m")}'\n`);
    process.exit(3);
}
if (mode === "hang") setInterval(() => undefined, 1000);
else {
    const out = `${value("-of")}.json`;
    fs.writeFileSync(out, mode === "bad-json" ? "{" : JSON.stringify({
        result: { language: "en" },
        transcription: [
            { offsets: { from: 0, to: 5410 }, text: " And so, my fellow Americans, ask not what" },
            { offsets: { from: 5410, to: 9040 }, text: " your country can do for you, ask what you" },
            { offsets: { from: 9040, to: 10500 }, text: " can do for your country." },
        ],
    }));
}

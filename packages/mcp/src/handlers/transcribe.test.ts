import type { CommandResult, EditorCommand } from "@opennan/timeline-core";
import type { PriceReply } from "../prices";
import type { StudioSession } from "../session";
import { TRANSCRIBE_HANDLERS } from "./transcribe";

function session(result: CommandResult) {
    const commands: EditorCommand[] = [];
    const fake = {
        projectId: "p", host: {},
        execute: async (command: EditorCommand) => { commands.push(command); return result; },
        snapshot: async () => ({ clips: [{ id: "c1", trackIndex: 4 }] }),
    } as unknown as StudioSession;
    return { fake, commands };
}

const call = (name: string, args: Record<string, unknown>, s: StudioSession) =>
    TRANSCRIBE_HANDLERS[name](args, { session: s, tool: {} as never, history: {} as never, signal: new AbortController().signal });

describe("transcription handlers", () => {
    it("build the ai.run command from the arguments", async () => {
        const { fake, commands } = session({ ok: true, changed: {}, output: { language: "th", segments: [] }, createdClipIds: [] });
        await call("auto_captions", { language: "th", model: "small" }, fake);
        expect(commands[0]).toEqual({ type: "ai.run", capability: "audio.transcribe", input: { language: "th", model: "small" }, placeAt: { kind: "captions-track", style: "caption" } });
        await call("transcribe_audio", { language: "en" }, fake);
        expect(commands[1]).toEqual({ type: "ai.run", capability: "audio.transcribe", input: { language: "en" } });
        await call("auto_captions", { engine: "local", style: "subtitle" }, fake);
        expect(commands[2]).toEqual({ type: "ai.run", capability: "audio.transcribe", input: { engine: "local" }, placeAt: { kind: "captions-track", style: "subtitle" } });
    });

    it("keep a host's reason when the capability is unavailable", async () => {
        const { fake } = session({ ok: false, changed: {}, unavailable: true, error: "This build has no whisper.cpp for win32-arm64." });
        const outcome = await call("auto_captions", {}, fake);
        expect(outcome.unavailable).toEqual({
            reason: "auto_captions requires a provider with the audio.transcribe capability. Connect OpenNan or another provider that offers it. This build has no whisper.cpp for win32-arm64.",
            capability: "audio.transcribe",
        });
    });

    it("report failures, cancellation, and empty transcripts in words", async () => {
        expect((await call("transcribe_audio", {}, session({ ok: false, changed: {}, error: "whisper.cpp failed (exit 3)" }).fake)).text).toBe("Transcription failed: whisper.cpp failed (exit 3)");
        expect((await call("auto_captions", {}, session({ ok: false, changed: {}, cancelled: true }).fake)).text).toBe("auto_captions was cancelled.");
        expect((await call("transcribe_audio", {}, session({ ok: true, changed: {}, output: { language: "en", segments: [] } }).fake)).text).toBe("No speech found in the timeline audio.");
        expect((await call("transcribe_audio", {}, session({ ok: true, changed: {}, output: "nope" }).fake)).ok).toBe(false);
        const placed = await call("auto_captions", {}, session({ ok: true, changed: {}, output: { language: "en", segments: [] }, createdClipIds: ["c1"] }).fake);
        expect(placed.text).toMatch(/^Added 1 caption on text track 4 \(language en\)/);
    });
});

describe("whole-timeline captions priced on the provider that runs them", () => {
    function priced(reply: PriceReply) {
        const commands: EditorCommand[] = [];
        const questions: unknown[] = [];
        const fake = {
            projectId: "p", host: {},
            execute: async (command: EditorCommand) => { commands.push(command); return { ok: true, changed: {}, output: { language: "en", segments: [] }, createdClipIds: [] }; },
            snapshot: async () => ({ tracks: [], scenes: [], clips: [{ id: "a1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 120, mediaUrl: "opennan-local://media/a", mediaType: "audio" }] }),
            estimate: async (question: unknown) => { questions.push(question); return reply; },
        } as unknown as StudioSession;
        return { fake, commands, questions };
    }
    const ESTIMATE: PriceReply = { kind: "estimate", estimate: { microUsd: 9537, usd: 0.009537, label: "≈ $0.010", units: 2, capped: false }, providerName: "OpenNan", priced: true };

    it("asks the price of the timeline's length and sends the estimate along", async () => {
        const { fake, commands, questions } = priced(ESTIMATE);
        const outcome = await call("auto_captions", {}, fake);
        expect(questions.at(-1)).toEqual(expect.objectContaining({ capability: "audio.transcribe", units: { seconds: 120 } }));
        expect(commands[0]).toMatchObject({ type: "ai.run", capability: "audio.transcribe", input: { expectedMaxUsd: 0.01 } });
        expect(outcome.ok).toBe(true);
    });

    it("runs free on the device without an estimate", async () => {
        const { fake, commands } = priced({ kind: "free", providerName: "On this device" });
        await call("transcribe_audio", {}, fake);
        expect(commands[0]).toEqual({ type: "ai.run", capability: "audio.transcribe", input: {} });
    });

    it("refuses a paid run whose price could not be checked; nothing runs", async () => {
        const { fake, commands } = priced({ kind: "unknown", reason: "OpenNan prices are not available right now.", providerName: "OpenNan", priced: true });
        const outcome = await call("auto_captions", {}, fake);
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toMatch(/price could not be checked/);
        expect(commands).toEqual([]);
    });
});

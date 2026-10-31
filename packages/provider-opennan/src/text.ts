// Story film on OpenNan: text.generate (POST /v1/chat/completions, one JSON answer, never streamed) and web.fetch (POST
// /v1/media/video-download: a video-site link's MP4 through OpenNan's proxy, no charge). A text call's images are
// project images (prepared and uploaded like any image input) or https links. A refused call (4xx before the model
// ran) charged nothing; a call that answered is billed on the tokens it used (usage.cost_usd).
import { JobFailedError, type CapabilityOutput } from "@opennan/provider-sdk";
import { OpenNanApiError, notChargedError } from "./errors";
import { number, text, type Input } from "./inputs";
import { DEFAULT_TEXT_MAX_TOKENS } from "./prices";
import { imageInput, type ToolContext } from "./tools";

/** At most this many images go with one text call. */
export const MAX_TEXT_IMAGES = 16;
export const MAX_TEXT_MAX_TOKENS = 32_000;
/** The prompt's longest text (characters). */
export const MAX_TEXT_PROMPT = 60_000;
/** The longest MP4 the download returns (the server's own cap). */
export const MAX_VIDEO_DOWNLOAD_BYTES = 256 * 1024 * 1024;

interface ChatAnswer {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { cost_usd?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** The text input's images (each a project image or an https link), uploaded in order. */
async function imagesOf(ctx: ToolContext, input: Input): Promise<string[]> {
    const raw = input.images;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_TEXT_IMAGES) throw new JobFailedError(`images must list at most ${MAX_TEXT_IMAGES} images.`);
    const urls: string[] = [];
    for (const [index, value] of raw.entries()) {
        const url = await imageInput(ctx, "text.generate", { image: value }, "image", true);
        if (!url) throw new JobFailedError(`images[${index}] is empty.`);
        urls.push(url);
    }
    return urls;
}

/** The answer's text: the first choice's content (a string, or text parts joined). */
function contentOf(answer: ChatAnswer): string {
    const content = answer.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    return "";
}

/** text.generate: { prompt, instruction?, images?, model, maxTokens? } → result { text, model, finishReason }. */
export async function runTextGenerate(ctx: ToolContext, input: Input, model: string): Promise<CapabilityOutput> {
    const prompt = text(input, "prompt", true, MAX_TEXT_PROMPT)!;
    const instruction = text(input, "instruction", false, MAX_TEXT_PROMPT);
    const maxTokens = number(input, "maxTokens", 1, MAX_TEXT_MAX_TOKENS) ?? DEFAULT_TEXT_MAX_TOKENS;
    const images = await imagesOf(ctx, input);
    const user = images.length === 0
        ? prompt
        : [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
    const messages = [...(instruction ? [{ role: "system", content: instruction }] : []), { role: "user", content: user }];
    ctx.job.report(null, "Writing");
    let answer: ChatAnswer;
    try {
        answer = await ctx.api.request<ChatAnswer>("POST", "/v1/chat/completions", {
            apiKey: ctx.key, body: { model, messages, max_tokens: Math.round(maxTokens), stream: false }, signal: ctx.job.signal,
        });
    } catch (error) {
        // An HTTP refusal comes before the model runs: nothing was charged (a lost connection may have been).
        if (error instanceof OpenNanApiError && error.status > 0 && !(error.status >= 500 && !error.fromServer)) throw notChargedError(error);
        throw error;
    }
    const written = contentOf(answer);
    if (!written.trim()) throw new JobFailedError("OpenNan returned no text.");
    const output: CapabilityOutput = {
        media: [],
        result: { text: written, model: typeof answer.model === "string" ? answer.model : model, finishReason: typeof answer.choices?.[0]?.finish_reason === "string" ? answer.choices[0].finish_reason : null },
    };
    const cost = answer.usage?.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) output.costUsd = cost;
    return output;
}

/** web.fetch: { url, maxHeight? } → the video at a video-site link as an MP4 (no charge). */
export async function runVideoDownload(ctx: ToolContext, input: Input): Promise<CapabilityOutput> {
    const url = text(input, "url", true, 4096)!;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new JobFailedError("url must be an https link.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new JobFailedError("url must be an https link.");
    const height = number(input, "maxHeight", 480, 2160);
    const maxHeight = height === undefined ? 720 : ([480, 720, 1080, 2160].find((h) => h >= height) ?? 2160);
    ctx.job.report(null, "Downloading");
    let file: { bytes: Uint8Array; mimeType: string };
    try {
        file = await ctx.api.requestBytes("POST", "/v1/media/video-download", { apiKey: ctx.key, body: { url, max_height: maxHeight }, signal: ctx.job.signal });
    } catch (error) {
        if (error instanceof OpenNanApiError && error.status > 0) throw notChargedError(error);
        throw error;
    }
    if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_VIDEO_DOWNLOAD_BYTES) throw new JobFailedError("OpenNan returned no complete video.");
    return { media: [{ kind: "video", bytes: file.bytes, mimeType: "video/mp4", name: "reference.mp4", sizeBytes: file.bytes.byteLength }], costUsd: 0 };
}

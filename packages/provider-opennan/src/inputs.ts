// Input checks shared by the OpenNan provider's capabilities: a bad input fails the job before any request.
import { JobFailedError } from "@opennan/provider-sdk";

export type Input = Record<string, unknown>;

export const MAX_TEXT = 4000;

export function text(input: Input, name: string, required: boolean, max = MAX_TEXT): string | undefined {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
        if (required) throw new JobFailedError(`${name} is required.`);
        return undefined;
    }
    if (typeof value !== "string") throw new JobFailedError(`${name} must be text.`);
    if (value.length > max) throw new JobFailedError(`${name} is longer than ${max} characters.`);
    return value;
}

export function httpsUrl(input: Input, name: string, required: boolean): string | undefined {
    const value = text(input, name, required, 4096);
    if (value === undefined) return undefined;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new JobFailedError(`${name} must be an https URL.`);
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new JobFailedError(`${name} must be an https URL.`);
    return value;
}

export function number(input: Input, name: string, min: number, max: number): number | undefined {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new JobFailedError(`${name} must be a number from ${min} to ${max}.`);
    return value;
}

export function flag(input: Input, name: string): boolean | undefined {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new JobFailedError(`${name} must be true or false.`);
    return value;
}

export function oneOf<T extends string>(input: Input, name: string, values: readonly T[], fallback: T): T {
    const value = input[name];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new JobFailedError(`${name} must be one of ${values.join(", ")}.`);
    return value as T;
}

export function defined(entries: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Links OpenNan answers with must be https; plain http only on loopback, and only when the API is on loopback (the fake server). */
export function allowedLink(url: string, loopbackApi: boolean): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) return false;
        if (parsed.protocol === "https:") return true;
        return loopbackApi && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
    } catch {
        return false;
    }
}

export function randomIdempotencyKey(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let out = "studio-";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

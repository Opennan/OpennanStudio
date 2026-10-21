// Every renderer → main call goes through here: the sender must be the app's own top frame, and the payload
// must parse with the channel's schema, before any handler code runs. Errors cross IPC as plain messages
// that never echo the payload.
import type { z } from "zod";
import { PAYLOADS, type IpcChannel, type IpcPayload } from "../../shared/ipc";
import { APP_ORIGIN } from "../protocol/csp";

export interface FrameLike {
    url: string;
    top?: unknown;
}

export interface IpcEventLike {
    senderFrame?: FrameLike | null;
    sender?: unknown;
}

export interface IpcMainLike {
    handle(channel: string, listener: (event: IpcEventLike, payload: unknown) => unknown): void;
}

export function isTrustedSender(frame: FrameLike | null | undefined, appOrigin = APP_ORIGIN): boolean {
    if (!frame) return false;
    if (frame.top !== undefined && frame.top !== frame) return false;
    return originOf(frame.url) === appOrigin;
}

/** scheme://host of a URL (URL.origin is "null" for custom schemes such as opennan-app:); null when unparsable. */
export function originOf(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
    } catch {
        return null;
    }
}

function describeIssue(error: z.ZodError): string {
    const issue = error.issues[0];
    return issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid";
}

export function handle<C extends IpcChannel, R>(
    ipc: IpcMainLike,
    channel: C,
    run: (payload: IpcPayload<C>, event: IpcEventLike) => R | Promise<R>,
    appOrigin = APP_ORIGIN,
): void {
    const schema = PAYLOADS[channel] as unknown as z.ZodTypeAny;
    ipc.handle(channel, async (event, payload) => {
        if (!isTrustedSender(event.senderFrame, appOrigin)) throw new Error("Untrusted IPC sender");
        const parsed = schema.safeParse(payload ?? {});
        if (!parsed.success) throw new Error(`Invalid ${channel} payload: ${describeIssue(parsed.error)}`);
        return run(parsed.data as IpcPayload<C>, event);
    });
}

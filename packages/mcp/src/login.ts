// opennan-studio login | logout | whoami: Sign in with OpenNan from a terminal (device flow, client "cli"). The
// code and link are printed; the browser opens unless --no-browser, an SSH session, or no display. The key goes to
// the 0600 credentials file and is never printed. OPENNAN_API_KEY, when set, wins over the file.
import os from "node:os";
import {
    DEFAULT_API_BASE, DEFAULT_CONSOLE_BASE, OpenNanSession, cleanDeviceName, createOpenNanApi, isAllowedApiBase, revokeKey, type SessionStatus,
} from "@opennan/provider-opennan";
import { API_KEY_ENV, credentialsPath, deleteCredentials, envCredentialStore, fileCredentialStore, readCredentials } from "./credentials";
import { shouldOpenBrowser } from "./open-browser";
import { formatBalance } from "./prices";

export interface AccountIo {
    stdout(text: string): void;
    stderr(text: string): void;
    home: string;
    env: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    /** Opens a URL in the default browser; false when it could not. */
    openUrl?(url: string): boolean;
    hostname?(): string;
}

export class AccountUsageError extends Error {}

/** Server text printed to a terminal: no control characters (escape sequences), bounded length. */
// eslint-disable-next-line no-control-regex
export const printable = (value: string | null | undefined) => (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 300);

const credits = (usd: number | null | undefined) => (typeof usd === "number" ? ` · Credits ${formatBalance(usd)}` : "");

export function resolveApiBase(flag: string | undefined, stored: string | undefined): string {
    const base = flag ?? stored ?? DEFAULT_API_BASE;
    if (!isAllowedApiBase(base)) throw new AccountUsageError(`--api must be an https URL (or http on 127.0.0.1/localhost), got ${base}`);
    return base.replace(/\/+$/, "");
}

/** The OpenNan session the CLI and `mcp serve` use: OPENNAN_API_KEY, else the credentials file. */
export async function cliSession(io: Pick<AccountIo, "env" | "home" | "platform" | "hostname">, apiFlag?: string): Promise<{ session: OpenNanSession; source: "env" | "file"; file: string; apiBase: string }> {
    const file = credentialsPath(io.env, io.home, io.platform ?? process.platform);
    const envKey = io.env[API_KEY_ENV]?.trim();
    const stored = envKey ? null : await readCredentials(file);
    // A saved key only ever goes back to the API it came from; --api / OPENNAN_API_BASE choose where a new sign-in
    // (or OPENNAN_API_KEY) goes, never where an existing saved key is sent.
    const apiBase = stored ? resolveApiBase(undefined, stored.apiBase) : resolveApiBase(apiFlag ?? io.env.OPENNAN_API_BASE, undefined);
    // opennan.com for the production API; another API (staging, the tests' fake server) serves its own console
    // unless OPENNAN_CONSOLE_BASE names one. The session prints/opens only that console's device page.
    const consoleBase = apiBase === DEFAULT_API_BASE ? DEFAULT_CONSOLE_BASE : (io.env.OPENNAN_CONSOLE_BASE && isAllowedApiBase(io.env.OPENNAN_CONSOLE_BASE) ? io.env.OPENNAN_CONSOLE_BASE : apiBase);
    const session = new OpenNanSession({
        api: createOpenNanApi({ baseUrl: apiBase }),
        consoleBase,
        store: envKey ? envCredentialStore(envKey) : fileCredentialStore(file, apiBase === DEFAULT_API_BASE ? undefined : apiBase),
        client: "cli",
        deviceName: cleanDeviceName(`CLI · ${(io.hostname ?? os.hostname)()}`),
    });
    return { session, source: envKey ? "env" : "file", file, apiBase };
}

function settledStatus(session: OpenNanSession): Promise<SessionStatus> {
    return new Promise((resolve) => {
        const check = (status: SessionStatus) => {
            if (status.state === "signed-in" || status.state === "error" || status.state === "signed-out") {
                stop();
                resolve(status);
            }
        };
        const stop = session.subscribe(check);
        check(session.status());
    });
}

export async function login(io: AccountIo, options: { api?: string; noBrowser?: boolean }): Promise<number> {
    const { session, source } = await cliSession(io, options.api);
    if (source === "env") io.stderr(`${API_KEY_ENV} is set: it takes precedence over the sign-in saved by login.\n`);
    if (source === "file") {
        await session.restore();
        const now = session.status();
        if (now.state === "signed-in") {
            io.stdout(`Already signed in${now.account ? ` as ${printable(now.account.email)}${credits(now.account.balanceUsd)}` : ""}. Run \`opennan-studio logout\` to switch accounts.\n`);
            return 0;
        }
    }
    const fileSession = source === "env" ? (await cliSession({ ...io, env: { ...io.env, [API_KEY_ENV]: undefined } }, options.api)).session : session;
    await fileSession.start({});
    const waiting = fileSession.status();
    if (waiting.state !== "waiting") {
        io.stderr(`Sign-in could not start: ${printable(waiting.state === "error" ? waiting.message : waiting.state)}\n`);
        return 1;
    }
    io.stdout(`Open ${printable(waiting.verificationUriComplete)}\nand check that the code is ${printable(waiting.userCode)}, then click Approve.\n`);
    const platform = io.platform ?? process.platform;
    if (shouldOpenBrowser(io.env, platform, options.noBrowser) && io.openUrl?.(waiting.verificationUriComplete)) io.stdout("Opened your browser.\n");
    io.stdout("Waiting for approval…\n");
    const done = await settledStatus(fileSession);
    await fileSession.settled();
    const final = fileSession.status();
    if (done.state !== "signed-in" || final.state !== "signed-in") {
        io.stderr(`Not signed in: ${printable(done.state === "error" ? done.message : "sign-in was cancelled")}\n`);
        return 1;
    }
    io.stdout(`Signed in as ${printable(final.account?.email) || "your OpenNan account"}${credits(final.account?.balanceUsd)}\n`);
    return 0;
}

export async function whoami(io: AccountIo, options: { api?: string }): Promise<number> {
    const { session, source } = await cliSession(io, options.api);
    await session.restore();
    const status = session.status();
    if (status.state !== "signed-in") {
        io.stderr(source === "env" ? `${API_KEY_ENV} is not accepted by OpenNan.\n` : "Not signed in. Run `opennan-studio login`.\n");
        return 1;
    }
    const from = source === "env" ? ` (from ${API_KEY_ENV})` : "";
    if (!status.account) {
        io.stdout(`Signed in${from}; OpenNan could not be reached to show the account.\n`);
        return 0;
    }
    io.stdout(`${printable(status.account.email)}${status.account.displayName ? ` (${printable(status.account.displayName)})` : ""}${credits(status.account.balanceUsd)}${status.account.keyName ? ` · key "${printable(status.account.keyName)}"` : ""}${from}\n`);
    return 0;
}

export async function logout(io: AccountIo, options: { api?: string }): Promise<number> {
    if (io.env[API_KEY_ENV]?.trim()) io.stderr(`${API_KEY_ENV} is set: unset it to stop using that key. The saved sign-in (if any) is removed now.\n`);
    const file = credentialsPath(io.env, io.home, io.platform ?? process.platform);
    const stored = await readCredentials(file);
    if (!stored) {
        io.stdout("Not signed in.\n");
        return 0;
    }
    // The key is revoked where it came from, whatever --api says.
    const apiBase = resolveApiBase(undefined, stored.apiBase);
    if (options.api && options.api.replace(/\/+$/, "") !== apiBase) io.stderr(`The saved key belongs to ${apiBase}; --api is ignored for it.\n`);
    const revoked = await revokeKey(createOpenNanApi({ baseUrl: apiBase }), stored.apiKey);
    await deleteCredentials(file);
    io.stdout(revoked ? "Signed out. The key was revoked.\n" : "Signed out. The key could not be revoked now; revoke it at opennan.com/console/keys.\n");
    return 0;
}

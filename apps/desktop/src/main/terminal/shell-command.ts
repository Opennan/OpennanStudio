// Turning a terminal profile into a process without letting any text become shell syntax.
// POSIX: the login shell runs `exec "$0" "$@"` with the command and its arguments as positional parameters,
// so a Finder-launched app gets the user's PATH and no argument is ever parsed by the shell.
// Windows: commands are resolved on PATH/PATHEXT; .cmd/.bat shims go through cmd.exe (by its full path) with a
// verbatim command line built the cross-spawn way: every argument quoted (MSVCRT rules), cmd metacharacters
// escaped twice (npm shims re-parse %*), delayed expansion off. node-pty passes a string argument unchanged.
import fs from "node:fs";
import path from "node:path";

export interface Launch {
    file: string;
    /** argv, or (Windows cmd.exe launches) a verbatim command line that node-pty appends unchanged. */
    args: string[] | string;
}

/** Splits a user-defined command into argv: quotes and backslash escapes only, no expansion of any kind. */
export function parseCommandLine(text: string): string[] {
    const args: string[] = [];
    let current = "";
    let has = false;
    let quote: "'" | "\"" | null = null;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote === "'") {
            if (char === "'") quote = null;
            else current += char;
            continue;
        }
        if (quote === "\"") {
            if (char === "\"") quote = null;
            else if (char === "\\" && (text[i + 1] === "\"" || text[i + 1] === "\\")) current += text[++i];
            else current += char;
            continue;
        }
        if (char === "'" || char === "\"") {
            quote = char;
            has = true;
        } else if (char === "\\" && i + 1 < text.length) {
            current += text[++i];
            has = true;
        } else if (/\s/.test(char)) {
            if (has) args.push(current);
            current = "";
            has = false;
        } else {
            current += char;
            has = true;
        }
    }
    if (quote) throw new Error("The command has an unterminated quote");
    if (has) args.push(current);
    if (args.length === 0) throw new Error("The command is empty");
    return args;
}

export const POSIX_EXEC = "exec \"$0\" \"$@\"";

export function posixLaunch(shell: string, argv: string[]): Launch & { args: string[] } {
    return { file: shell, args: ["-l", "-c", POSIX_EXEC, ...argv] };
}

/** Quotes one argument for CommandLineToArgvW / the MSVCRT parser. */
export function quoteWindowsArg(arg: string): string {
    if (arg !== "" && !/[\s"]/.test(arg)) return arg;
    let out = "\"";
    let slashes = 0;
    for (const char of arg) {
        if (char === "\\") {
            slashes += 1;
            continue;
        }
        if (char === "\"") {
            out += "\\".repeat(slashes * 2 + 1) + "\"";
        } else {
            out += "\\".repeat(slashes) + char;
        }
        slashes = 0;
    }
    return `${out}${"\\".repeat(slashes * 2)}"`;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escapes cmd.exe metacharacters with ^. */
export function escapeCmdMeta(text: string): string {
    return text.replace(CMD_META, "^$1");
}

/** One argument for a .cmd/.bat command line: MSVCRT quoting, then cmd escaping twice (cross-spawn's escapeArgument). */
export function escapeCmdShimArg(arg: string): string {
    const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
    return escapeCmdMeta(escapeCmdMeta(quoted));
}

export function windowsLaunch(resolved: string, argv: string[], comspec = "C:\\Windows\\System32\\cmd.exe"): Launch {
    if (/\.(cmd|bat)$/i.test(resolved)) {
        const line = [escapeCmdMeta(resolved), ...argv.map(escapeCmdShimArg)].join(" ");
        return { file: comspec, args: `/d /v:off /s /c "${line}"` };
    }
    return { file: resolved, args: argv };
}

export interface PathLookup {
    PATH?: string;
    PATHEXT?: string;
    platform: NodeJS.Platform;
    exists?(file: string): boolean;
}

/** The absolute file a command name runs, or null. */
export function findOnPath(command: string, lookup: PathLookup): string | null {
    const exists = lookup.exists ?? ((file: string) => {
        try {
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    });
    const pathApi = lookup.platform === "win32" ? path.win32 : path.posix;
    const extensions = lookup.platform === "win32" ? (lookup.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    const candidates = (base: string) => (lookup.platform === "win32" && pathApi.extname(base) ? [base, ...extensions.map((e) => base + e)] : extensions.map((e) => base + e));
    if (command.includes("/") || (lookup.platform === "win32" && command.includes("\\"))) {
        if (!pathApi.isAbsolute(command)) return null;
        return candidates(command).find(exists) ?? null;
    }
    for (const dir of (lookup.PATH ?? "").split(lookup.platform === "win32" ? ";" : ":").filter(Boolean)) {
        const found = candidates(pathApi.join(dir, command)).find(exists);
        if (found) return found;
    }
    return null;
}

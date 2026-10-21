import { execFileSync } from "node:child_process";
import { escapeCmdMeta, escapeCmdShimArg, findOnPath, parseCommandLine, posixLaunch, quoteWindowsArg, windowsLaunch } from "./shell-command";

describe("parseCommandLine", () => {
    it.each([
        ["aider --model \"gpt 5\"", ["aider", "--model", "gpt 5"]],
        ["echo $HOME; rm -rf ~", ["echo", "$HOME;", "rm", "-rf", "~"]],
        ["opencode 'it''s'", ["opencode", "its"]],
        ["tool a\\ b \"q\\\"x\"", ["tool", "a b", "q\"x"]],
        ["  x   ''  ", ["x", ""]],
        ["run `id` $(whoami) | cat && ls", ["run", "`id`", "$(whoami)", "|", "cat", "&&", "ls"]],
    ])("%s", (text, expected) => {
        expect(parseCommandLine(text)).toEqual(expected);
    });

    it("refuses unterminated quotes and empty commands", () => {
        expect(() => parseCommandLine("x 'oops")).toThrow("unterminated");
        expect(() => parseCommandLine("   ")).toThrow("empty");
    });
});

describe("posixLaunch", () => {
    it("passes the command and arguments as positional parameters", () => {
        expect(posixLaunch("/bin/zsh", ["claude", "; rm -rf /"])).toEqual({ file: "/bin/zsh", args: ["-l", "-c", "exec \"$0\" \"$@\"", "claude", "; rm -rf /"] });
    });

    it.skipIf(process.platform === "win32")("never lets the shell parse an argument", () => {
        const { file, args } = posixLaunch("/bin/sh", ["printf", "%s|", "a b", "$(id)", "`id`", "; echo pwned"]);
        expect(execFileSync(file, args.filter((a) => a !== "-l"), { encoding: "utf8" })).toBe("a b|$(id)|`id`|; echo pwned|");
    });
});

describe("Windows quoting", () => {
    it.each([
        ["simple", "simple"], ["a b", "\"a b\""], ["a\"b", "\"a\\\"b\""], ["C:\\dir with space\\", "\"C:\\dir with space\\\\\""], ["", "\"\""],
        ["C:\\plain\\path", "C:\\plain\\path"],
    ])("quotes %j", (arg, expected) => {
        expect(quoteWindowsArg(arg)).toBe(expected);
    });

    it("escapes cmd metacharacters twice for .cmd shims and builds one verbatim command line", () => {
        expect(escapeCmdMeta("a&calc|x%PATH%!y")).toBe("a^&calc^|x^%PATH^%^!y");
        expect(escapeCmdShimArg("&calc")).toBe("^^^\"^^^&calc^^^\"");
        expect(escapeCmdShimArg("a b")).toBe("^^^\"a^^^ b^^^\"");
        expect(escapeCmdShimArg("q\"x")).toBe("^^^\"q\\^^^\"x^^^\"");
        expect(windowsLaunch("C:\\Program Files\\npm\\claude.cmd", ["&calc", "100%"])).toEqual({
            file: "C:\\Windows\\System32\\cmd.exe",
            args: "/d /v:off /s /c \"C:\\Program^ Files\\npm\\claude.cmd ^^^\"^^^&calc^^^\" ^^^\"100^^^%^^^\"\"",
        });
        expect(windowsLaunch("C:\\bin\\codex.exe", ["-c", "a b"])).toEqual({ file: "C:\\bin\\codex.exe", args: ["-c", "a b"] });
    });

    it.skipIf(process.platform !== "win32")("a real .cmd shim receives every argument unchanged through node-pty", async () => {
        const { spawn } = await import("node-pty");
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan cmd "));
        fs.writeFileSync(path.join(dir, "argv.js"), "process.stdout.write('ARGV' + JSON.stringify(process.argv.slice(2)) + 'END')");
        fs.writeFileSync(path.join(dir, "shim.cmd"), `@"${process.execPath}" "%~dp0argv.js" %*\r\n`);
        const args = ["a&b", "%PATH%", "!x!", "^", "|", "\"q\"", "with space", "C:\\dir\\"];
        const launch = windowsLaunch(path.join(dir, "shim.cmd"), args, `${process.env.SystemRoot}\\System32\\cmd.exe`);
        const output = await new Promise<string>((resolve) => {
            let text = "";
            const pty = spawn(launch.file, launch.args, { name: "xterm", cols: 200, rows: 24, cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } as Record<string, string> });
            pty.onData((d) => { text += d; });
            pty.onExit(() => resolve(text));
        });
        const match = /ARGV(.*)END/s.exec(output.replace(/\r?\n/g, ""));
        expect(JSON.parse(match![1])).toEqual(args);
    });
});

describe("findOnPath", () => {
    it("searches PATH and PATHEXT", () => {
        const files = new Set(["/usr/local/bin/claude", "C:\\npm\\codex.CMD"]);
        expect(findOnPath("claude", { PATH: "/usr/bin:/usr/local/bin", platform: "darwin", exists: (f) => files.has(f) })).toBe("/usr/local/bin/claude");
        expect(findOnPath("codex", { PATH: "C:\\Windows;C:\\npm", PATHEXT: ".EXE;.CMD", platform: "win32", exists: (f) => files.has(f) })).toBe("C:\\npm\\codex.CMD");
        expect(findOnPath("missing", { PATH: "/usr/bin", platform: "linux", exists: () => false })).toBeNull();
        expect(findOnPath("./relative/tool", { PATH: "/usr/bin", platform: "linux", exists: () => true })).toBeNull();
        expect(findOnPath("/opt/tool", { platform: "linux", exists: () => true })).toBe("/opt/tool");
    });
});

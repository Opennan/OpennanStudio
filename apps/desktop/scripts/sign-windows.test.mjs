// node --test: the Windows signing hook with a fake CodeSignTool (no SSL.com account needed).
import assert from "node:assert";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { signFile } = createRequire(import.meta.url)("./sign-windows.cjs");

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cst-"));
    fs.mkdirSync(path.join(dir, "jar"));
    fs.writeFileSync(path.join(dir, "jar", "code_sign_tool-1.3.3.jar"), "");
    const file = path.join(dir, "App Setup 1.0.exe");
    fs.writeFileSync(file, "MZ unsigned");
    const env = { ES_USERNAME: "user", ES_PASSWORD: "p@ss word;$(x)", ES_TOTP_SECRET: "totp", CODESIGNTOOL_DIR: dir };
    return { dir, file, env };
}
const outArg = (args) => args.find((a) => a.startsWith("-output_dir_path=")).slice(17);

test("signs in place, passing the password as one argument with no shell", () => {
    const { dir, file, env } = setup();
    let seen;
    signFile(file, env, (cmd, args, opts) => {
        seen = { cmd, args, opts };
        fs.writeFileSync(path.join(outArg(args), path.basename(file)), "MZ unsigned + signature");
    });
    assert.equal(fs.readFileSync(file, "utf8"), "MZ unsigned + signature");
    assert.equal(seen.cmd, "java");
    assert.ok(seen.args.includes("-password=p@ss word;$(x)"));
    assert.ok(seen.args.includes(`-input_file_path=${file}`));
    assert.ok(!seen.args.some((a) => a.startsWith("-credential_id")));
    assert.equal(seen.opts.cwd, dir);
});

test("uses the bundled Java and the credential id when given", () => {
    const { dir, file, env } = setup();
    fs.mkdirSync(path.join(dir, "jdk-11.0.2", "bin"), { recursive: true });
    let seen;
    signFile(file, { ...env, ES_CREDENTIAL_ID: "cred-1" }, (cmd, args) => {
        seen = { cmd, args };
        fs.writeFileSync(path.join(outArg(args), path.basename(file)), "signed");
    });
    assert.ok(seen.cmd.includes(path.join("jdk-11.0.2", "bin")));
    assert.ok(seen.args.includes("-credential_id=cred-1"));
});

test("fails without settings, on a tool error, or when nothing was signed, and never prints the password", () => {
    const { file, env } = setup();
    assert.throws(() => signFile(file, { ...env, ES_PASSWORD: "" }), /ES_PASSWORD/);
    const err = assert.throws(() => signFile(file, env, () => { const e = new Error("boom p@ss word;$(x)"); e.status = 1; throw e; }), (e) => {
        assert.match(e.message, /exit 1/); assert.ok(!e.message.includes("p@ss")); return true; });
    assert.throws(() => signFile(file, env, () => {}), /did not sign/);
    assert.throws(() => signFile(file, env, (c, args) => fs.copyFileSync(file, path.join(outArg(args), path.basename(file)))), /did not sign/);
    assert.equal(fs.readFileSync(file, "utf8"), "MZ unsigned");
});

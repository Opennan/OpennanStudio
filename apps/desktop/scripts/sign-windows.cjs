// Windows code signing with the company's SSL.com certificate (eSigner cloud key) through SSL.com's
// CodeSignTool. electron-builder calls this for every Windows file it signs (win.signtoolOptions.sign),
// only when ES_USERNAME is set; otherwise builds stay unsigned.
//
// Settings (CI secrets, never in the repo or the logs):
//   ES_USERNAME, ES_PASSWORD   the SSL.com account that owns the certificate
//   ES_CREDENTIAL_ID           the eSigner credential id (needed when the account has more than one)
//   ES_TOTP_SECRET             the eSigner OTP secret, so signing needs no one at the keyboard
//   CODESIGNTOOL_DIR           an unpacked CodeSignTool (SSL.com's Windows zip bundles its own Java)
// The signed copy replaces the file in place. Nothing here prints a setting's value.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tool(dir) {
    const jars = fs.readdirSync(path.join(dir, "jar")).filter((name) => /^code_sign_tool-[\d.]+\.jar$/.test(name)).sort();
    if (!jars.length) throw new Error(`No CodeSignTool jar in ${dir}`);
    const bundled = fs.readdirSync(dir).find((name) => /^jdk-/.test(name));
    const java = bundled ? path.join(dir, bundled, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
    return { java, jar: path.join(dir, "jar", jars[jars.length - 1]) };
}

function signFile(file, env = process.env, run = execFileSync) {
    const missing = ["ES_USERNAME", "ES_PASSWORD", "ES_TOTP_SECRET", "CODESIGNTOOL_DIR"].filter((name) => !env[name]);
    if (missing.length) throw new Error(`Windows signing needs ${missing.join(", ")}`);
    const dir = env.CODESIGNTOOL_DIR;
    const { java, jar } = tool(dir);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "esigner-"));
    try {
        const args = ["-jar", jar, "sign", `-username=${env.ES_USERNAME}`, `-password=${env.ES_PASSWORD}`,
            `-totp_secret=${env.ES_TOTP_SECRET}`, `-input_file_path=${file}`, `-output_dir_path=${out}`];
        if (env.ES_CREDENTIAL_ID) args.push(`-credential_id=${env.ES_CREDENTIAL_ID}`);
        try {
            // No shell, so the password is never parsed; output is not echoed (it may name the account).
            run(java, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            throw new Error(`CodeSignTool failed for ${path.basename(file)} (exit ${error.status ?? "?"})`);
        }
        const signed = path.join(out, path.basename(file));
        // CodeSignTool can exit 0 after a refused request; only a changed (signature-carrying) copy counts.
        if (!fs.existsSync(signed) || fs.readFileSync(signed).equals(fs.readFileSync(file))) {
            throw new Error(`CodeSignTool did not sign ${path.basename(file)}`);
        }
        fs.copyFileSync(signed, file);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
}

module.exports = async function sign(configuration) {
    signFile(configuration.path);
};
module.exports.signFile = signFile;

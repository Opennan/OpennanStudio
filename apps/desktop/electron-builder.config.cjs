// Local/PR packages may be unsigned. Release packages fail without signing credentials and,
// on macOS, notarization. Stable updates use separate Cloudflare R2 feeds per platform/architecture.
// Each package command builds the host architecture only: native modules are built for it by
// scripts/ensure-native.mjs, and only its ffmpeg is fetched.
const releaseUpdates = process.env.OPENNAN_RELEASE_UPDATES === "true";
const windowsProvider = process.env.OPENNAN_WINDOWS_SIGNING || "certificate";
const azure = process.platform === "win32" && windowsProvider === "azure";
if (process.platform === "win32" && !["certificate", "azure"].includes(windowsProvider)) throw new Error("Unknown Windows signing provider");
if (azure) {
    for (const key of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE", "AZURE_SIGNING_PUBLISHER"]) {
        if (!process.env[key]?.trim()) throw new Error(`Azure signing requires ${key}`);
    }
    if (!/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(process.env.AZURE_SIGNING_ENDPOINT)) throw new Error("Azure signing requires a Microsoft signing endpoint");
}
const signed = Boolean(process.platform === "win32" ? (azure || process.env.WIN_CSC_LINK || process.env.CSC_LINK) : (process.env.CSC_LINK || process.env.CSC_NAME));
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
if (releaseUpdates && (!signed || !["darwin", "win32"].includes(process.platform))) throw new Error("Studio releases require platform signing credentials");
if (releaseUpdates && process.platform === "darwin" && !notarize) throw new Error("Studio macOS releases require Apple notarization credentials");
const ffmpeg = (os) => [{ from: `resources/ffmpeg/${os}-\${arch}`, to: "ffmpeg", filter: ["ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe", "LICENSE.txt", "SOURCE.txt"] }];
// whisper.cpp (spec §5.9): whisper-cli, its Linux libraries, the MIT notices, SOURCE.txt, and checksums.json
// (provider-local checks every listed file before the first run).
const whisper = (os) => [{
    from: `resources/whisper/${os}-\${arch}`, to: "whisper",
    filter: ["whisper-cli", "whisper-cli.exe", "*.so*", "LICENSE.txt", "MODELS-LICENSE.txt", "SOURCE.txt", "checksums.json"],
}];

module.exports = {
    appId: "com.opennan.studio",
    productName: "OpenNan Studio",
    copyright: "Copyright © 2026 OpenNan",
    artifactName: "OpenNan-Studio-${version}-${os}-${arch}.${ext}",
    forceCodeSigning: releaseUpdates,
    directories: { output: "release", buildResources: "build" },
    files: ["dist/main/**", "dist/preload/**", "dist/renderer/**", "!**/*.map", "!dist/main/metafile-*.json", "package.json", "LICENSE"],
    // Updates only for signed builds: an unsigned update is checked only against the sha512 in the same release.
    extraMetadata: { name: "opennan-studio", opennanUpdates: releaseUpdates },
    asar: true,
    asarUnpack: ["**/*.node", "**/node-pty/build/Release/spawn-helper", "**/node-pty/prebuilds/**"],
    npmRebuild: false,
    electronFuses: {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
        loadBrowserProcessSpecificV8Snapshot: false,
        grantFileProtocolExtraPrivileges: false,
    },
    // Separate feeds prevent one Mac architecture from replacing the other's latest-mac.yml.
    publish: [{ provider: "generic", url: `https://cdn.opennan.com/programs/studio/${process.platform}-${process.arch}/` }],
    mac: {
        minimumSystemVersion: "13.0.0",
        category: "public.app-category.video",
        target: ["dmg", "zip"],
        artifactName: "OpenNan-Studio-${version}-darwin-${arch}.${ext}",
        // Hardened runtime is for notarized (signed) builds; with an ad-hoc signature it would refuse to load the
        // Electron framework (library validation needs one Team ID).
        hardenedRuntime: signed,
        entitlements: "build/entitlements.mac.plist",
        entitlementsInherit: "build/entitlements.mac.plist",
        // Unsigned builds get an ad-hoc signature: Apple Silicon kills unsigned code, and flipping the fuses breaks
        // the linker signature Electron ships with.
        ...(signed ? {} : { identity: "-" }),
        notarize,
        extraResources: [...ffmpeg("darwin"), ...whisper("darwin")],
    },
    win: {
        target: ["nsis"], artifactName: "OpenNan-Studio-${version}-win32-${arch}.${ext}",
        verifyUpdateCodeSignature: true, extraResources: [...ffmpeg("win32"), ...whisper("win32")],
        ...(azure ? { azureSignOptions: {
            publisherName: process.env.AZURE_SIGNING_PUBLISHER,
            endpoint: process.env.AZURE_SIGNING_ENDPOINT,
            certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
            codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
            fileDigest: "SHA256", timestampDigest: "SHA256",
        } } : {}),
    },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
    linux: {
        target: ["AppImage", "deb"],
        executableName: "opennan-studio",
        category: "AudioVideo",
        maintainer: "OpenNan <studio@opennan.com>",
        extraResources: [...ffmpeg("linux"), ...whisper("linux")],
    },
    deb: { packageName: "opennan-studio" },
};

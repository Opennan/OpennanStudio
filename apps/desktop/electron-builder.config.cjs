// electron-builder config (spec §7.2). Signing and notarization run only when their secrets are present;
// local and CI builds are unsigned. Auto-update metadata points at GitHub Releases; src/main/updates.ts keeps
// the updater off unless a release build sets OPENNAN_RELEASE_UPDATES=true ("opennanUpdates" in package.json).
// Each package command builds the host architecture only: native modules are built for it by
// scripts/ensure-native.mjs, and only its ffmpeg is fetched.
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
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
    directories: { output: "release", buildResources: "build" },
    files: ["dist/main/**", "dist/preload/**", "dist/renderer/**", "!**/*.map", "!dist/main/metafile-*.json", "package.json", "LICENSE"],
    // Updates only for signed builds: an unsigned update is checked only against the sha512 in the same release.
    extraMetadata: { name: "opennan-studio", opennanUpdates: signed && process.env.OPENNAN_RELEASE_UPDATES === "true" },
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
    publish: [{ provider: "github", owner: "Opennan", repo: "OpennanStudio", releaseType: "release" }],
    mac: {
        category: "public.app-category.video",
        target: ["dmg", "zip"],
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
    win: { target: ["nsis"], extraResources: [...ffmpeg("win32"), ...whisper("win32")] },
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

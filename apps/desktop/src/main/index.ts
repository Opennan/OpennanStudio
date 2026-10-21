// OpenNan Studio desktop main process (spec §7.2): one window running the web editor shell, with projects in
// SQLite, media files behind opennan-media://, native export on the bundled LGPL ffmpeg, the MCP server, and
// terminal sessions. Everything privileged stays here; the renderer reaches it only through validated IPC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, Menu, MessageChannelMain, app, dialog, ipcMain, protocol, safeStorage, session, shell, type MenuItemConstructorOptions } from "electron";
import * as nodePty from "node-pty";
import { E2E_ARGUMENT } from "../shared/bridge";
import { EVENTS, IPC } from "../shared/ipc";
import { MCP_CLIENTS, buildMcpConfig, isLoopbackHttpUrl } from "@opennan/mcp";
import { registerAccountIpc } from "./account/account-ipc";
import { createAccountService, openNanBases } from "./account/account-service";
import { createCloudHost, type CloudHost } from "./cloud/cloud-host";
import { registerCloudIpc } from "./cloud/cloud-ipc";
import { registerAiIpc } from "./ai/ai-ipc";
import { createDesktopMediaPreparer } from "./ai/prepare-media";
import { createStabilizeService } from "./ai/stabilize";
import { createTranscriptionService } from "./ai/transcription";
import { resolveWhisper } from "./ai/whisper-paths";
import { createDesktopExporter } from "./export/desktop-exporter";
import { registerExportIpc } from "./export/export-ipc";
import { createDesktopExportJobs } from "./export/export-jobs";
import { createGpuJobs, sweepGpuTemp, type GpuJobs } from "./export/gpu-jobs";
import { resolveFfmpeg } from "./export/ffmpeg-paths";
import { createGuardedProbe } from "./export/probe";
import { createProviderHost } from "./providers/provider-host";
import { registerProvidersIpc } from "./providers/providers-ipc";
import { handle, type IpcMainLike } from "./ipc/handle";
import { registerProjectIpc } from "./ipc/project-ipc";
import { registerSettingsIpc } from "./ipc/settings-ipc";
import { isBridgeMode, runBridgeMode } from "./mcp/bridge-mode";
import { createMcpHost } from "./mcp/mcp-host";
import { registerSessionIpc } from "./mcp/session-ipc";
import { desktopPaths, ensureDirs, projectDir } from "./paths";
import { buildLaunch } from "./terminal/profiles";
import { createPtyManager, type PtySpawn } from "./terminal/pty-manager";
import { registerTerminalIpc } from "./terminal/terminal-ipc";
import { createAppProtocolHandler } from "./protocol/app-protocol";
import { APP_ORIGIN, APP_SCHEME, MEDIA_SCHEME } from "./protocol/csp";
import { createMediaProtocolHandler } from "./protocol/media-protocol";
import { forbiddenDebugSwitches, hardenContents, isSafeExternalUrl, lockPermissions, windowOptions } from "./security/window";
import { openDatabase } from "./store/database";
import { createMediaStore } from "./store/media-store";
import { createSecretStore } from "./store/secrets";
import { createSettingsStore } from "./store/settings";
import { startUpdates, type UpdaterLike } from "./updates";
import { createLocalReferenceScan, createSqlitePersistence } from "./store/sqlite-persistence";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const PRELOAD = path.join(__dirname, "..", "preload", "index.cjs");

function startApp(): void {
    if (app.isPackaged) {
        // Local software could otherwise drive the editor (and its terminal) over Chromium's remote debugging.
        const refused = forbiddenDebugSwitches(process.argv, (name) => app.commandLine.hasSwitch(name));
        if (refused.length > 0) {
            process.stderr.write(`OpenNan Studio does not start with debugging switches: ${refused.join(", ")}\n`);
            app.exit(1);
            return;
        }
    }
    app.setName("OpenNan Studio");
    if (process.platform === "win32") app.setAppUserModelId("com.opennan.studio");
    if (process.env.OPENNAN_STUDIO_USER_DATA && path.isAbsolute(process.env.OPENNAN_STUDIO_USER_DATA)) {
        app.setPath("userData", process.env.OPENNAN_STUDIO_USER_DATA);
    }
    protocol.registerSchemesAsPrivileged([
        { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
        { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    ]);
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }

    let window: BrowserWindow | null = null;
    const cleanups: Array<() => unknown> = [];
    app.on("second-instance", () => {
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.focus();
    });
    app.on("window-all-closed", () => app.quit());
    app.on("before-quit", () => {
        for (const cleanup of cleanups.splice(0).reverse()) {
            try {
                void cleanup();
            } catch {
                // keep quitting
            }
        }
    });

    void app.whenReady().then(() => {
        const paths = desktopPaths({ userData: app.getPath("userData"), videos: app.getPath("videos"), env: process.env });
        ensureDirs(paths);
        const ffmpeg = resolveFfmpeg({
            env: process.env, resourcesPath: process.resourcesPath, appPath: app.getAppPath(),
            platform: process.platform, arch: process.arch, isPackaged: app.isPackaged,
        });
        const db = openDatabase(paths.database);
        cleanups.push(() => db.close());
        const media = createMediaStore({
            db, root: paths.media,
            probe: ffmpeg ? createGuardedProbe(ffmpeg.ffprobePath) : undefined,
        });
        const persistence = createSqlitePersistence({ db, media });
        const settings = createSettingsStore(db);
        const secrets = createSecretStore({ db, safeStorage });
        const ipc = ipcMain as unknown as IpcMainLike;

        protocol.handle(APP_SCHEME, createAppProtocolHandler(RENDERER_DIR));
        // Cloud files still downloading are served through the cloud host, created further down (phase 9a.1).
        let cloudHost: CloudHost | null = null;
        protocol.handle(MEDIA_SCHEME, createMediaProtocolHandler(media, { streaming: (id) => cloudHost?.streamSource(id) ?? null }));
        lockPermissions(session.defaultSession);

        let sessions: ReturnType<typeof registerSessionIpc> | null = null;
        const effects = async () => {
            const attached = sessions?.current();
            return attached ? (await attached.rpc.call("listEffects", ["effect"])) as never : [];
        };
        // The editor window's GPU exports (phase 10c) and main's own ffmpeg exports never run at once.
        let gpuJobs: GpuJobs | null = null;
        const exporter = createDesktopExporter({
            ffmpeg, mediaStore: media, exportsDir: paths.exports, effects, busy: () => gpuJobs?.active() ?? false,
        });
        gpuJobs = createGpuJobs({
            runner: exporter.runner, mainBusy: () => exporter.exporter.isBusy(), setTarget: (name) => exporter.setTarget(name), effects,
        });
        // Temp folders of GPU jobs a crash or a quit mid-export left behind.
        void sweepGpuTemp();
        cleanups.push(() => void gpuJobs?.abortAll("The app quit during the export."));
        const send = (channel: string, payload: unknown) => {
            if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
        };
        // Both export sources as one exporter for MCP and the Export dialog (phase 10d): agents follow and cancel
        // the window's GPU exports by their gpu-… ids.
        const exportJobs = createDesktopExportJobs({
            main: exporter.exporter, gpu: gpuJobs, setTarget: (name) => exporter.setTarget(name),
            cancelWindowJob: (jobId) => send(EVENTS.exportGpuCancel, { jobId }),
        });
        // On-device transcription (auto captions): whisper.cpp bundled next to ffmpeg, models under userData.
        const whisper = resolveWhisper({
            env: process.env, resourcesPath: process.resourcesPath, appPath: app.getAppPath(),
            platform: process.platform, arch: process.arch, isPackaged: app.isPackaged,
        });
        // AI tools' media (phase 11): ranges of imported media trimmed by the bundled ffmpeg, for whisper and the cloud uploads.
        const preparer = createDesktopMediaPreparer({ ffmpeg, mediaStore: media });
        const transcription = createTranscriptionService({ whisperDir: whisper.dir, reason: whisper.reason, ffmpeg, mediaStore: media, modelsDir: paths.models, preparer });
        const stabilize = createStabilizeService({ ffmpeg, mediaStore: media, preparer });
        cleanups.push(registerAiIpc(ipc, { service: transcription, stabilize, send }));
        cleanups.push(() => transcription.cancelAll());
        cleanups.push(() => stabilize.cancelAll());
        // Sign in with OpenNan and cloud providers: the key and every cloud call stay in main (phase 8).
        const bases = openNanBases(process.env, app.isPackaged);
        const account = createAccountService({
            apiBase: bases.apiBase, consoleBase: bases.consoleBase, secrets, deviceName: os.hostname(), send, warn: console.warn,
            openExternal: (url) => shell.openExternal(url),
            focusWindow: () => {
                if (!window || window.isDestroyed()) return;
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
                if (process.platform === "darwin") app.focus({ steal: true });
            },
        });
        registerAccountIpc(ipc, { account });
        const providerHost = createProviderHost({
            session: account.session, mediaStore: media, send, allowLoopbackDownloads: bases.overridden, falKey: () => secrets.get("FAL_KEY"), prepareMedia: preparer.prepareMedia,
        });
        registerProvidersIpc(ipc, { host: providerHost });
        // OpenNan cloud projects (phase 9a): the renderer's cloud backend calls the API, uploads and downloads through
        // main, with the same account and API base; cloud state files live under userData/cloud. The media cache keeps
        // to the limit in settings and never evicts a file a local project's saved document names (phase 9a.1).
        cloudHost = createCloudHost({
            apiBase: bases.apiBase, session: account.session, mediaStore: media, root: paths.cloud, warn: console.warn,
            limit: { get: () => settings.get().cloudCacheLimitBytes, set: (bytes) => void settings.update({ cloudCacheLimitBytes: bytes }) },
            localReferences: createLocalReferenceScan(db),
        });
        cleanups.push(registerCloudIpc(ipc, { host: cloudHost, exportsDir: paths.exports }));
        cleanups.push(() => providerHost.cancelAll());
        registerProjectIpc(ipc, { persistence, media });
        registerSettingsIpc(ipc, { settings, secrets, onSecretsChange: () => providerHost.syncKeys() });
        cleanups.push(registerExportIpc(ipc, { desktop: exporter, gpuJobs, jobs: exportJobs, exportsDir: paths.exports, send, showItemInFolder: (file) => shell.showItemInFolder(file) }));
        const mcp = createMcpHost({ tokenFile: paths.tokenFile, preferredPort: settings.get().mcpPort });
        mcp.token();
        cleanups.push(() => mcp.close());
        const bridgeLaunch = () => mcp.bridgeLaunch({ execPath: process.execPath, appPath: app.getAppPath(), isPackaged: app.isPackaged });
        sessions = registerSessionIpc(ipc, {
            host: mcp, exporter: exportJobs, mediaStore: media, projectDir: (id) => projectDir(paths, id), send, providers: providerHost.registry,
            captionsRoute: () => settings.get().providerRouting.overrides["audio.transcribe"] ?? null,
            shareWithoutAsking: () => settings.get().agentSharesWithoutAsking,
            loopbackShares: (() => {
                try {
                    return isLoopbackHttpUrl(new URL(bases.apiBase));
                } catch {
                    return false;
                }
            })(),
            capturePage: async () => {
                if (!window) throw new Error("The editor window is closed");
                const image = await window.webContents.capturePage();
                const size = image.getSize();
                return { mimeType: "image/png", data: new Uint8Array(image.toPNG()), width: size.width, height: size.height };
            },
        });
        handle(ipc, IPC.mcpInfo, () => ({
            ...mcp.info(),
            tokenFile: paths.tokenFile,
            configs: Object.fromEntries(MCP_CLIENTS.map((client) => {
                try {
                    return [client, buildMcpConfig(client, bridgeLaunch(), { cwd: "<project folder>", home: app.getPath("home") }).text];
                } catch (error) {
                    return [client, error instanceof Error ? error.message : String(error)];
                }
            })) as Record<"claude" | "codex" | "gemini", string>,
        }));
        const terminals = createPtyManager({
            spawn: nodePty.spawn as unknown as PtySpawn,
            send: (kind, payload) => send(kind === "data" ? EVENTS.terminalData : EVENTS.terminalExit, payload),
        });
        cleanups.push(() => terminals.killAll());
        registerTerminalIpc(ipc, {
            manager: terminals,
            projectDir: (id) => projectDir(paths, id),
            launchFor: (profile, dir) => buildLaunch({
                profile, settings: settings.get(), projectDir: dir, bridge: bridgeLaunch, platform: process.platform,
                env: process.env, home: app.getPath("home"), secret: (name) => secrets.get(name),
            }),
        });
        handle(ipc, IPC.appInfo, () => ({
            version: app.getVersion(), platform: process.platform, arch: process.arch,
            ffmpeg: { available: exporter.available }, whisper: { available: transcription.status().available },
        }));

        Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
        window = new BrowserWindow(windowOptions(PRELOAD, process.env.OPENNAN_STUDIO_E2E === "1" ? [E2E_ARGUMENT] : []));
        hardenContents(window.webContents, (url) => {
            if (!isSafeExternalUrl(url) || !window) return;
            // Ask first: page content (agent-written text included) must not open URLs silently.
            void dialog.showMessageBox(window, { type: "question", buttons: ["Open in browser", "Cancel"], defaultId: 1, cancelId: 1, message: "Open this link in your browser?", detail: url.slice(0, 500) })
                .then(({ response }) => {
                    if (response === 0) void shell.openExternal(url);
                });
        });
        window.once("ready-to-show", () => window?.show());
        window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
            // A reload drops the page's editor: stop serving its project until it attaches again.
            if (isMainFrame && !isInPlace) {
                void sessions?.detachAll("The editor reloaded");
                terminals.killAll();
                // Nobody is left to place the result of a running transcription or stabilize.
                void transcription.cancelAll();
                void stabilize.cancelAll();
                // Nor to finish a GPU export (phase 10c): end its job so exports are not blocked until restart (and
                // agents see it failed instead of running forever).
                void gpuJobs?.abortAll("The editor window reloaded during the export.");
            }
        });
        window.webContents.on("render-process-gone", () => {
            void gpuJobs?.abortAll("The editor window stopped unexpectedly during the export.");
        });
        window.webContents.on("did-finish-load", () => {
            // Fresh drawing ports for the export runner after every page load.
            const rasterChannel = new MessageChannelMain();
            const glChannel = new MessageChannelMain();
            exporter.attachRendererPorts(rasterChannel.port1, glChannel.port1);
            window?.webContents.postMessage(EVENTS.exportPorts, null, [rasterChannel.port2, glChannel.port2]);
        });
        window.on("closed", () => {
            void sessions?.detachAll("The editor window closed");
            void transcription.cancelAll();
            void stabilize.cancelAll();
            void gpuJobs?.abortAll("The editor window closed during the export.");
            exporter.detachRenderer();
            window = null;
        });
        void window.loadURL(`${APP_ORIGIN}/index.html`);
        const packageJson = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as { opennanUpdates?: unknown };
        cleanups.push(startUpdates({ isPackaged: app.isPackaged, packageJson, env: process.env }, () => require("electron-updater").autoUpdater as UpdaterLike, console.warn));
    });
}

function menuTemplate(): MenuItemConstructorOptions[] {
    // No Undo/Redo roles: Cmd/Ctrl+Z belongs to the editor's own history (apps/web shortcuts).
    const edit: MenuItemConstructorOptions = { label: "Edit", submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] };
    const view: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] }];
    const appMenu: MenuItemConstructorOptions[] = process.platform === "darwin"
        ? [{ role: "appMenu" }]
        : [{ label: "File", submenu: [{ role: "quit" }] }];
    return [...appMenu, edit, ...view, { role: "windowMenu" }];
}

if (isBridgeMode(process.argv)) void runBridgeMode(process.argv, app);
else startApp();

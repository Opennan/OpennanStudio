// Electron entry for `bench-export.mjs --host electron`: one window on the playground's bench page, so the GPU
// export runs in Electron's Chromium (the desktop renderer's engine: WebGL2 + hardware WebCodecs).
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
    const window = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { backgroundThrottling: false } });
    void window.loadURL(process.argv[process.argv.length - 1]);
});
app.on("window-all-closed", () => app.quit());

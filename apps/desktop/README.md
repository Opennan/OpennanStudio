# OpenNan Studio desktop (`apps/desktop`)

The OpenNan Studio editor as a desktop app for macOS, Windows, and Linux: the same editor screen as `apps/web`
(projects, media bin, timeline, preview, properties, shortcuts) in Electron, with projects in SQLite, media as
files on disk, MP4 export up to 4K on a bundled LGPL ffmpeg, on-device auto captions with a bundled whisper.cpp,
a built-in MCP server, and a terminal panel that starts Claude Code, Codex CLI, Gemini CLI, or your own command in
the project folder, already connected to the open timeline.

## Develop

```bash
pnpm install
pnpm --filter @opennan/desktop fetch:ffmpeg   # macOS: builds LGPL ffmpeg 7.1.5 from source (~3 min); Windows/Linux: downloads a pinned BtbN LGPL build
pnpm --filter @opennan/desktop fetch:whisper  # macOS/Windows: builds whisper.cpp 1.9.5 from source with CMake (~30 s); Linux: downloads the pinned upstream build
pnpm --filter @opennan/desktop dev            # build and run
pnpm --filter @opennan/desktop test           # unit tests, run inside Electron's Node
pnpm --filter @opennan/desktop e2e            # Playwright-Electron smoke against the built app
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @opennan/desktop package --mac dmg zip --arm64   # unsigned installer for this machine's architecture
node apps/desktop/scripts/packaged-smoke.mjs "apps/desktop/release/mac-arm64/OpenNan Studio.app/Contents/MacOS/OpenNan Studio"
```

`scripts/ensure-native.mjs` builds `better-sqlite3` for Electron's ABI (tests, dev runs, and packages share it)
and restores the execute bit of node-pty's `spawn-helper`. In unpackaged runs `OPENNAN_FFMPEG`/`OPENNAN_FFPROBE`
may point at another ffmpeg, and `OPENNAN_WHISPER_DIR` at another whisper.cpp folder (with its `checksums.json`);
packaged builds only ever use the bundled ones. `fetch:whisper` runs CMake from `PATH`, or `OPENNAN_CMAKE`.

## Where things live

| What | Where |
|---|---|
| Projects, media index, settings, encrypted API keys, the OpenNan sign-in (internal keychain-encrypted slot) | `<userData>/opennan-studio.sqlite` |
| Imported media (copies; copy-on-write clones on APFS, btrfs, ReFS) | `<userData>/media/<id>.<ext>` |
| Project folders (terminal working directory, agent configs) | `<userData>/projects/<project id>/` |
| MCP access token (0600, new every run) | `<userData>/mcp/token` |
| Whisper models for auto captions (downloaded on first use) | `<userData>/models/whisper/ggml-<model>.bin` |
| Exports | `<Videos>/OpenNan Studio/<project>-<date>-<time>.mp4` |

`OPENNAN_STUDIO_USER_DATA` and `OPENNAN_STUDIO_EXPORTS_DIR` (absolute paths) move them for tests.

## Agents (MCP)

While a project is open, the app serves it at `http://127.0.0.1:4319/mcp` (another port if that one is busy;
Settings shows it) with a bearer token. Agents edit the same timeline you see, with the same undo history.

- **Terminal panel**: pick Claude Code, Codex CLI, Gemini CLI, Shell, or Custom and press Start. Before an
  agent starts, the app writes its MCP config: `.mcp.json` (Claude Code) or `.gemini/settings.json` (Gemini
  CLI) in the project folder, or `-c mcp_servers.opennan-studio.*` options on Codex's command line. The entry
  runs this app in `--mcp-bridge` mode, which reads the token file; the token is never in a config file,
  an argument, or the terminal's environment. Stored API keys go only to their own CLI
  (`ANTHROPIC_API_KEY` → claude, `OPENAI_API_KEY` → codex, `GEMINI_API_KEY` → gemini).
- **Other terminals**: Settings → MCP server shows each CLI's entry. HTTP clients can use
  `Authorization: Bearer $OPENNAN_STUDIO_MCP_TOKEN` with the token read from the token file.
- Agents can only use media imported into the project (`opennan-local://media/…`); `publish_video_to_timeline`
  and `publish_audio_to_timeline` import files from the project folder. Other media URLs are refused, and the
  preview never loads them (a banner lists them).

## Auto captions

Editor → **Auto captions** transcribes the timeline's audio on this computer and adds one caption text clip per
spoken line on a new "Captions" text track (one undo step). Pick the language (or auto-detect) and the model:
Tiny (74 MB), Base (141 MB, default), or Small (465 MB). The first use of a model downloads it once from the
whisper.cpp project's Hugging Face repository at a pinned revision, over HTTPS only; the file is checked against its
pinned SHA-256 before it is used, and a mismatch is deleted. Progress shows the download, the audio mix, and the
transcription; Cancel stops whichever runs.

How it runs: main renders the timeline's audio mix (16 kHz mono WAV) with the bundled ffmpeg from imported media
only, then runs `whisper-cli` as a separate process with an argument list (no shell), after checking it and its
libraries against `Resources/whisper/checksums.json`. One transcription runs at a time. Agents get the same
through MCP: `auto_captions` places captions, `transcribe_audio` returns the timed text. The web app shows the
feature with what it needs instead (no on-device provider in a browser).

whisper.cpp 1.9.5 is MIT-licensed: built from the pinned source on macOS (static, Metal, system frameworks only)
and Windows (static runtime, no Visual C++ redistributable needed), the pinned upstream archives on Linux
(`whisper/manifest.json`). `Resources/whisper/` ships its `LICENSE.txt`, the models' MIT notice
(`MODELS-LICENSE.txt`), and `SOURCE.txt`; `pnpm check:licenses` checks every fetched folder.

## ffmpeg license

The app runs ffmpeg 7.1.5 as a separate process, built LGPL-only (no `--enable-gpl`, no `--enable-nonfree`,
no x264): on macOS from the pinned source tarball by `ffmpeg/build-macos.sh` (VideoToolbox for H.264, system
frameworks only, no network protocols), on Windows and Linux from pinned BtbN `lgpl` archives (Media
Foundation, VA-API, or OpenH264 for H.264). Every archive is checked against the SHA-256 in
`ffmpeg/manifest.json`, and `pnpm --filter @opennan/desktop check:ffmpeg` (also part of `pnpm check:licenses`)
fails on any GPL or non-free component. The app ships the license text, the source URL with its SHA-256, and the
configure line in `Resources/ffmpeg/LICENSE.txt` and `SOURCE.txt`.

## Sign in with OpenNan

The account lives in the main process: the device flow, the `sk-` key (safeStorage, an internal slot the renderer can neither list nor read), the balance, and every OpenNan or fal.ai job. The renderer gets statuses and notices only, and proxy providers whose jobs run in main; finished jobs' media is downloaded in main (https only, no credentials, 512 MB cap) and imported into the media library. The browser opens with `shell.openExternal` only for the console's `/console/device` page (and the fixed billing, usage, and keys pages), without the link dialog; the window comes to the front when sign-in succeeds. On Linux without a keyring (`basic_text`) the key stays in memory until Studio quits, and the modal says so. An agent call that needs OpenNan while signed out answers with the guidance and shows a non-modal "An agent wants to use OpenNan AI · Sign in" toast. `OPENNAN_STUDIO_API_BASE` / `OPENNAN_STUDIO_CONSOLE_BASE` point at a fake server only in an unpackaged `OPENNAN_STUDIO_E2E=1` run.

## Security model

- The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node integration), loads only
  `opennan-app://app` files with a strict CSP (no remote origins; `'unsafe-eval'` only because regl compiles GL
  effect shaders with `Function`), cannot navigate away, open windows, attach webviews, or get permissions other
  than clipboard writes and fullscreen.
- The preload exposes one typed `window.opennan`; every IPC call is checked for the app's own top frame and
  validated with a zod schema in main before anything runs.
- `opennan-media://blob/<id>` serves only files of the media library (ids from the database, real paths inside
  the media folder) with byte ranges and CORS for the app origin only.
- Terminal profiles are chosen by id; commands run as argv through `exec "$0" "$@"` (POSIX) or with escaped
  arguments (Windows `.cmd` shims), so no text reaches a shell parser. Custom commands are split without any
  expansion.
- The terminal panel runs commands by design, so the editor renderer is trusted with it: a renderer compromise
  (none known; local files only, strict CSP) could use the terminal. Moving the terminal into its own view with
  its own preload is planned. External links open only after a confirmation; packaged builds refuse
  remote-debugging and inspector switches.
- Packaged builds flip Electron's fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, asar
  integrity checks, app code only from the asar.

## Signing and updates

Signing and notarization happen only when their variables are set: macOS `CSC_LINK` (+ `CSC_KEY_PASSWORD`),
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; Windows `CSC_LINK`/`WIN_CSC_LINK`. Unsigned macOS
builds get an ad-hoc signature (right-click → Open on first launch). Auto-update from GitHub Releases is
configured but stays off unless a release build is packaged with `OPENNAN_RELEASE_UPDATES=true`;
`OPENNAN_DISABLE_UPDATES=1` turns it off anywhere.

## Known limits

- No AV1 decoding in the macOS ffmpeg build (no dav1d); H.264, HEVC, ProRes, VP8/VP9, and the common audio
  formats decode natively.
- Linux H.264 export needs VA-API hardware or the OpenH264 encoder in the bundled build; otherwise MPEG-4 Part 2
  with a warning.
- Unsigned builds show OS warnings on first launch; the placeholder app icon is not final.
- Auto captions: no whisper.cpp build for Windows on Arm yet (the feature then explains it is unavailable). The
  Windows and Linux whisper builds are verified only in CI. Transcription uses the CPU's baseline instruction set
  on Windows (no per-CPU variants) and Metal on macOS.

# @opennan/mcp

MCP server for the OpenNan Studio editor, built on the official MCP TypeScript SDK.

- `createStudioMcpServer(session)` (also importable from `@opennan/mcp/server`, which has no Node-only imports): a host-agnostic server over a `StudioSession` (`createControllerSession({ controller, store, backend })` builds one from a `TimelineController`). Tool calls on one session run one at a time; `undo_last_edit` undoes whole tool calls.
- Transports: `serveStdio(session)` and `startHttpServer(session, { port })`, which binds to `127.0.0.1`, requires `Authorization: Bearer <token>`, caps sessions, and fails on a busy port.
- Editor tools run offline through `TimelineController.execute`, with the editor's undo history and its lock and overlap rules. `generate_quick_image`, `generate_video_h3`, `generate_tts`, `add_music`, and `generate_sfx` run `ai.run` on the host's providers (OpenNan by default) and answer with media imported into the project's library (`opennan-local://media/…`, ready for `create_timeline_clip`); signed out of OpenNan they answer "Connect OpenNan: run `opennan-studio login` or sign in from Studio's account chip." The other generation tools stay listed and answer "Connect OpenNan" or "requires a provider" (cloud projects come later).
- `assemble_video` runs `export.start` through `@opennan/export` (`createStudioExporter({ runner })`, the same pipeline as the editor's Export button) and `get_export_status` reports the job; the same runner renders `preview_timeline_frame` images. `mcp serve` does this with the native ffmpeg named by `--ffmpeg` (or `OPENNAN_FFMPEG`; `--ffprobe`/`OPENNAN_FFPROBE`, else the ffprobe next to it), reads media only from the project's `<file>.media/` folder, and writes exports to `<project folder>/exports/` (`--export-dir`). Without an ffmpeg both answer unavailable.

CLI:

```bash
opennan-studio login                      # Sign in with OpenNan: opens opennan.com with the code; Approve there
opennan-studio login --no-browser         # print the link and code only (also automatic over SSH or without a display)
opennan-studio whoami                     # ada@example.com (Ada) · Credits $12.40
opennan-studio logout                     # revokes the key and deletes the credentials file
opennan-studio project new film.opennan.json
opennan-studio mcp serve --project film.opennan.json                 # stdio; holds film.opennan.json.lock
opennan-studio mcp serve --project film.opennan.json --http          # http://127.0.0.1:4319/mcp, token in film.opennan.json.mcp-token (0600)
opennan-studio mcp serve --project film.opennan.json --allow-dir ~/Footage   # publish_* may read from ~/Footage too
opennan-studio mcp serve --project film.opennan.json --ffmpeg /opt/homebrew/bin/ffmpeg   # assemble_video and frames on native ffmpeg
opennan-studio mcp serve --project film.opennan.json --tools offline       # list only the 40 tools that run offline
opennan-studio mcp-config --client claude --project film.opennan.json --write
opennan-studio mcp-config --client codex --transport http --write
opennan-studio mcp-config --client gemini --transport bridge --token-file film.opennan.json.mcp-token --write
```

`login` saves the key to `~/.config/opennan-studio/credentials.json` (`$XDG_CONFIG_HOME` honoured; `%APPDATA%\opennan-studio\credentials.json` on Windows), folder 0700, file 0600; the key is never printed. `OPENNAN_API_KEY` overrides the file. `mcp serve` uses that account for the generation tools.

HTTP configs read the token from `OPENNAN_STUDIO_MCP_TOKEN` (for example `export OPENNAN_STUDIO_MCP_TOKEN=$(cat film.opennan.json.mcp-token)`). Bridge configs start `opennan-studio mcp bridge`, a stdio server that forwards to the HTTP server, for sessions another process hosts (the desktop app). The bridge outlives that server: it starts even when nothing listens yet, reconnects after an idle session close or a restart (reading the token file again), retries a refused connection with a bounded backoff, and answers a tool call with a tool error, without exiting, when the server stays down.

`publish_audio_to_timeline` and `publish_video_to_timeline` read only audio or video files inside the project folder or an `--allow-dir` folder (symlinks resolved).

Until providers are installed, the 86 generation tools only answer "unavailable" but still take room in the agent's context; `--tools offline` (or `createStudioMcpServer(session, { tools: toolsForPreset("offline") })`) lists only the 40 editor tools. A tool call that does not finish within 10 minutes (`callTimeoutMs`) answers a timeout error, and a tool call that fails part way is undone.

Codex CLI releases that predate its built-in streamable-HTTP client need `experimental_use_rmcp_client = true` at the top of `config.toml` for the `--transport http` entry; the `--transport bridge` entry works on every release.

Checked with: Claude Code 2.1.303 and Codex CLI 0.163.0 read the stdio, http, and bridge entries (`claude mcp list`, `codex mcp list`; Codex 0.163 takes the `url` entry without the experimental flag). Gemini CLI was not installed when this was checked.

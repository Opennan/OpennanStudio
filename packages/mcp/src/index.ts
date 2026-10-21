// Public API of @opennan/mcp (Node). Desktop (phase 6) builds a StudioSession over
// its controller, serves it with startHttpServer, and points CLI agents at it with
// `opennan-studio mcp bridge`. The CLI itself is the package bin, not an export.
export * from "./server-api";
export { startHttpServer, DEFAULT_HTTP_PORT, LOOPBACK_HOST, MCP_PATH, type HttpServerOptions, type StudioHttpServer } from "./http";
export { serveStdio } from "./stdio";
export { startBridge, sessionLost, isLoopbackHttpUrl, BRIDGE_REQUEST_TIMEOUT_MS, type BridgeOptions, type RunningBridge } from "./bridge";
export { TOKEN_ENV, createSessionToken, bearerMatches, isAllowedHost, isAllowedOrigin, isValidToken } from "./auth";
export { openHeadlessProject, FFMPEG_ENV, FFPROBE_ENV, type HeadlessOptions, type HeadlessStudio } from "./headless";
export {
    PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, ProjectFileError, parseProjectFile, serializeProjectFile,
    readProjectFile, writeProjectFile, openFilePersistence, lockProjectFile, mediaDirFor, blobPathFor,
    type ProjectFile, type FilePersistence, type ProjectLock,
} from "./project-file";
export {
    createLocalFileReader, mimeTypeFor, isRemotePath, LOCAL_MEDIA_TYPES,
    type LocalMediaKind, type LocalFileReader, type LocalFileReaderOptions,
} from "./local-files";
export {
    MCP_CLIENTS, DEFAULT_SERVER_NAME, buildMcpConfig, mergeMcpConfig, configPath, definesTomlServer,
    type McpClient, type McpLaunch, type ConfigSnippet, type ConfigLocation,
} from "./mcp-config";

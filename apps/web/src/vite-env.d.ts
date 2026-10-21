/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Where the ffmpeg.wasm core is served (default ./ffmpeg-core, self-hosted next to the app). */
    readonly VITE_FFMPEG_CORE_BASE?: string;
    /** "true" turns on libx264 in the web export (pending the spec §12 legal review). */
    readonly VITE_WEB_EXPORT_ALLOW_GPL?: string;
    /** e2e builds only: the fake OpenNan server (vite.config.ts). Ignored in every other mode. */
    readonly VITE_OPENNAN_API_BASE?: string;
    readonly VITE_OPENNAN_CONSOLE_BASE?: string;
}

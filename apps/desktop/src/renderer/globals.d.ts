import type { DesktopBridge } from "../shared/bridge";

declare global {
    interface Window {
        /** The preload bridge (src/preload/index.ts). */
        opennan: DesktopBridge;
    }
}

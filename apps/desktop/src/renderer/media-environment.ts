// The preview's MediaEnvironment on desktop: imported media plays from opennan-media://blob/<id>; every
// other URL (an agent's https:// or file:// URL included) resolves to a refused URL that never loads
// (shared/media-policy.ts; the editor shows a banner, media-banner.tsx).
import type { MediaEnvironment } from "@opennan/timeline-media";
import { previewMediaUrl } from "../shared/media-policy";

export function createDesktopMediaEnvironment(appOrigin: string): MediaEnvironment {
    return {
        resolveMediaUrl: (url) => previewMediaUrl(url, appOrigin).url,
        canFetchMediaBytes: (url) => previewMediaUrl(url, appOrigin).allowed,
        shouldPreloadBlob: () => false,
        origin: appOrigin,
    };
}

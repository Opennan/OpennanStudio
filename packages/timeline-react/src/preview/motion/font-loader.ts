// Bundled text fonts in the preview (phase 10b). `document.fonts.ready` does not load faces nothing has
// used yet, so the compositor asks for each face a text clip needs (text/fonts.ts fontFacesForStyle) and
// redraws when it arrives; until then the text draws with the fallback stack.
import type { TextFontFace } from "@opennan/timeline-core/text/fonts";

export interface FontSetLike {
    check(font: string): boolean;
    load(font: string): Promise<unknown>;
}

/** The CSS font shorthand that selects a face (size is irrelevant to matching). */
export function fontFaceQuery(face: TextFontFace): string {
    return `${face.style === "italic" ? "italic " : ""}${face.weight} 32px "${face.family}"`;
}

export class FontLoader {
    private readonly requested = new Set<string>();
    private readonly ready = new Set<string>();

    /** `onLoaded` runs once per face that finishes loading (the compositor drops stale bitmaps and redraws). */
    constructor(private readonly fonts: FontSetLike | null, private readonly onLoaded: (face: TextFontFace) => void) {}

    /** True when every face is usable now; otherwise requests the missing ones (once each) and returns false. */
    ensure(faces: readonly TextFontFace[]): boolean {
        if (!this.fonts || faces.length === 0) return true;
        let all = true;
        for (const face of faces) {
            const query = fontFaceQuery(face);
            if (this.ready.has(query)) continue;
            let usable = false;
            try {
                usable = this.fonts.check(query);
            } catch {
                usable = true;
            }
            if (usable) {
                this.ready.add(query);
                continue;
            }
            all = false;
            if (this.requested.has(query)) continue;
            this.requested.add(query);
            this.fonts.load(query).then(
                () => {
                    this.ready.add(query);
                    this.onLoaded(face);
                },
                () => {
                    // A face that cannot load keeps the fallback; stop asking.
                    this.ready.add(query);
                },
            );
        }
        return all;
    }
}

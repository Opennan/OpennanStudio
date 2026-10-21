// The OpenNan theme for the Studio shell. The tokens live in @opennan/timeline-react
// (src/theme/tokens.css, shipped in styles.css) under .opennan-theme; the fonts they name are
// bundled here (SIL OFL 1.1, listed in THIRD_PARTY_NOTICES) so the app needs no font CDN offline.
// Imported from JS rather than CSS so the build's notices plugin sees the font packages.
import "@fontsource-variable/inter";
import "@fontsource-variable/hubot-sans";
import { useLayoutEffect } from "react";

export const THEME_CLASS = "opennan-theme";

/** Puts the token class on <html> for hosts whose page does not already carry it (apps/web's index.html does). */
export function useStudioTheme(): void {
    useLayoutEffect(() => {
        document.documentElement.classList.add(THEME_CLASS);
    }, []);
}

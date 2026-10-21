// Template id → draw function (phase 10d). Every id in templates.ts has an entry.
import type { GraphicsDraw } from "../types";
import { drawAnimatedTitle } from "./animated-title";
import { drawArrowCallout } from "./arrow-callout";
import { drawBarChart } from "./bar-chart";
import { drawCaptionPop } from "./caption-pop";
import { drawCard } from "./card";
import { drawConfettiBurst } from "./confetti-burst";
import { drawCountdown } from "./countdown";
import { drawDonutChart } from "./donut-chart";
import { drawGradientBackdrop } from "./gradient-backdrop";
import { drawHighlightSpot } from "./highlight-spot";
import { drawLineChart } from "./line-chart";
import { drawLogoSting } from "./logo-sting";
import { drawLowerThird } from "./lower-third";
import { drawProgressBar } from "./progress-bar";
import { drawShapeWipe } from "./shape-wipe";
import { drawSocialHandle } from "./social-handle";
import { drawStatCounter } from "./stat-counter";
import { drawSubscribeButton } from "./subscribe-button";
import { drawTypewriterText } from "./typewriter-text";

/** Runs a draw inside save/restore, so no template leaves font, alpha, or transform state on the host's context. */
const guarded = (draw: GraphicsDraw): GraphicsDraw => (ctx, frame) => {
    ctx.save();
    try {
        return draw(ctx, frame);
    } finally {
        ctx.restore();
    }
};

export const GRAPHICS_DRAWS: Readonly<Record<string, GraphicsDraw>> = Object.fromEntries(Object.entries({
    "animated-title": drawAnimatedTitle,
    "lower-third": drawLowerThird,
    "caption-pop": drawCaptionPop,
    "bar-chart": drawBarChart,
    "countdown": drawCountdown,
    "progress-bar": drawProgressBar,
    "logo-sting": drawLogoSting,
    "card": drawCard,
    "subscribe-button": drawSubscribeButton,
    "social-handle": drawSocialHandle,
    "arrow-callout": drawArrowCallout,
    "highlight-spot": drawHighlightSpot,
    "line-chart": drawLineChart,
    "donut-chart": drawDonutChart,
    "stat-counter": drawStatCounter,
    "confetti-burst": drawConfettiBurst,
    "shape-wipe": drawShapeWipe,
    "gradient-backdrop": drawGradientBackdrop,
    "typewriter-text": drawTypewriterText,
} satisfies Record<string, GraphicsDraw>).map(([id, draw]) => [id, guarded(draw)]));

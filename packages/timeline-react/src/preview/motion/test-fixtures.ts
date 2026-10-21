// Test helpers for preview/motion: a clip factory and a recording 2D context (jsdom has no canvas).
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";

export function testClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
    return {
        id: "c1", projectId: "p", trackType: "video", trackIndex: 2, startTime: 10, endTime: 14, mediaUrl: "/m.mp4", mediaType: "video",
        sceneId: null, label: null, thumbnailUrl: null, locked: false, volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none",
        audioDenoise: false, audioNormalize: false, playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false,
        fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none", transitionDuration: 0, opacity: 1, scale: 1,
        positionX: 0.5, positionY: 0.5, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
        brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false,
        chromaKeyColor: "#00ff00", chromaKeySimilarity: 0.1, chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0,
        rotationDegrees: 0, keyframesJson: null, textContent: null, textStyle: null, trimStart: null, trimEnd: null,
        ...overrides,
    } as TimelineClip;
}

export interface RecordedCall {
    name: string;
    args: unknown[];
}

/**
 * A 2D context that records every method call (and font at fillText time). measureText: fixed advance
 * per character (`charWidth` × font px / 10), so layout is deterministic.
 */
export class RecordingContext {
    readonly calls: RecordedCall[] = [];
    font = "10px sans-serif";
    textAlign: CanvasTextAlign = "left";
    textBaseline: CanvasTextBaseline = "alphabetic";
    fillStyle: unknown = "#000";
    strokeStyle: unknown = "#000";
    lineWidth = 1;
    lineJoin: CanvasLineJoin = "miter";
    shadowColor = "transparent";
    shadowBlur = 0;
    shadowOffsetX = 0;
    shadowOffsetY = 0;
    globalAlpha = 1;
    constructor(readonly canvas: { width: number; height: number } = { width: 0, height: 0 }) {}
    private rec(name: string, args: unknown[]) {
        this.calls.push({ name, args });
    }
    private fontPx(): number {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
        return m ? Number(m[1]) : 10;
    }
    measureText(text: string) {
        return { width: [...text].length * this.fontPx() * 0.5 } as TextMetrics;
    }
    fillText(...args: unknown[]) { this.rec("fillText", args); }
    strokeText(...args: unknown[]) { this.rec("strokeText", args); }
    fillRect(...args: unknown[]) { this.rec("fillRect", args); }
    clearRect(...args: unknown[]) { this.rec("clearRect", args); }
    beginPath() { this.rec("beginPath", []); }
    closePath() { this.rec("closePath", []); }
    moveTo(...args: unknown[]) { this.rec("moveTo", args); }
    lineTo(...args: unknown[]) { this.rec("lineTo", args); }
    stroke() { this.rec("stroke", []); }
    fill() { this.rec("fill", []); }
    save() { this.rec("save", []); }
    restore() { this.rec("restore", []); }
    translate(...args: unknown[]) { this.rec("translate", args); }
    rotate(...args: unknown[]) { this.rec("rotate", args); }
    scale(...args: unknown[]) { this.rec("scale", args); }
    setTransform(...args: unknown[]) { this.rec("setTransform", args); }
    transform(...args: unknown[]) { this.rec("transform", args); }
    drawImage(...args: unknown[]) { this.rec("drawImage", args); }
    rect(...args: unknown[]) { this.rec("rect", args); }
    clip() { this.rec("clip", []); }
    arc(...args: unknown[]) { this.rec("arc", args); }
    strokeRect(...args: unknown[]) { this.rec("strokeRect", args); }
    setLineDash(...args: unknown[]) { this.rec("setLineDash", args); }
    named(name: string): RecordedCall[] {
        return this.calls.filter((call) => call.name === name);
    }
}

/** A canvas factory whose contexts record (for helpers that create offscreen canvases). */
export function recordingCanvasFactory() {
    const contexts: RecordingContext[] = [];
    const createCanvas = (width: number, height: number) => {
        const canvas = { width, height, getContext: (_id: "2d") => ctx };
        const ctx = new RecordingContext(canvas);
        contexts.push(ctx);
        return canvas;
    };
    return { createCanvas, contexts };
}

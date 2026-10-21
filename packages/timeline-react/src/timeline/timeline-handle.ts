// Imperative API replacing the window CustomEvents that hosts used to drive the
// timeline (nle-timeline.tsx:2006-2015, 3033-3040, 3134-3153).
export interface TimelineHandle {
    /** Was the timeline-split-at-playhead window event (editor-layout.tsx:1828). */
    splitAtPlayhead(options?: { activeTrackOnly?: boolean }): void;
    /** Was the add-effect-layer window event (effects-tab.tsx:159). */
    addEffectLayer(effectId: string, name?: string): void;
    /** Was the add-remotion-graphic window event (right-panel.tsx:68,76). */
    addGraphic(input: { templateId?: string; customGraphicId?: string; name?: string; durationSeconds?: number }): void;
}

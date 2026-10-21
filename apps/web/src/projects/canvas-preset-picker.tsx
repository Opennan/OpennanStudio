import { useId } from "react";
import { CANVAS_PRESETS } from "./canvas-presets";
import "./canvas-preset-picker.css";

/** Radio group of the four canvas presets; `compact` is the editor top bar variant. */
export function CanvasPresetPicker({ value, onChange, compact = false }: { value: string; onChange(ratio: string): void; compact?: boolean }) {
    const name = useId();
    return (
        <div role="radiogroup" aria-label="Canvas" className={compact ? "preset-picker compact" : "preset-picker"}>
            {CANVAS_PRESETS.map((preset) => {
                const checked = value === preset.ratio;
                return (
                    <label key={preset.ratio} className="preset" data-checked={checked || undefined} title={preset.hint}>
                        <input
                            type="radio"
                            name={name}
                            value={preset.ratio}
                            checked={checked}
                            onChange={() => onChange(preset.ratio)}
                            aria-label={`${preset.ratio} ${preset.label}`}
                        />
                        <span className="preset-glyph" style={{ aspectRatio: preset.ratio.replace(":", " / ") }} aria-hidden="true" />
                        <span className="preset-ratio">{preset.ratio}</span>
                        {!compact && <span className="preset-label">{preset.label}</span>}
                    </label>
                );
            })}
        </div>
    );
}

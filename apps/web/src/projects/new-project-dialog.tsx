import { useState, type FormEvent } from "react";
import { DEFAULT_PROJECT_NAME, type CreateProjectInput } from "@opennan/timeline-core";
import { Dialog } from "../ui/dialog";
import { errorMessage } from "../ui/format";
import { CanvasPresetPicker } from "./canvas-preset-picker";
import { DEFAULT_CANVAS_RATIO } from "./canvas-presets";

export function NewProjectDialog({ onCancel, onCreate }: { onCancel(): void; onCreate(input: CreateProjectInput): Promise<void> }) {
    const [name, setName] = useState("");
    const [ratio, setRatio] = useState<string>(DEFAULT_CANVAS_RATIO);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await onCreate({ name: name.trim() || DEFAULT_PROJECT_NAME, aspectRatio: ratio });
        } catch (cause) {
            setError(errorMessage(cause));
            setBusy(false);
        }
    };

    return (
        <Dialog title="New project" onClose={onCancel}>
            <form className="dialog-body" onSubmit={(event) => void submit(event)}>
                <label className="field">
                    <span>Project name</span>
                    <input className="text-input" autoFocus value={name} placeholder={DEFAULT_PROJECT_NAME} onChange={(event) => setName(event.target.value)} />
                </label>
                <fieldset className="field">
                    <legend>Canvas</legend>
                    <CanvasPresetPicker value={ratio} onChange={setRatio} />
                </fieldset>
                {error && <p role="alert" className="error-text">{error}</p>}
                <div className="dialog-footer">
                    <button type="button" className="button ghost" onClick={onCancel}>Cancel</button>
                    <button type="submit" className="button primary" disabled={busy}>Create project</button>
                </div>
            </form>
        </Dialog>
    );
}

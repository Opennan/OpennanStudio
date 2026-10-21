// "Create from image": sends an image to the local layer-import service (tooling/layer-import/serve.py)
// and hands the finished design to the editor. Dev only: fal bills the FAL_KEY of whoever runs the service.
import { useEffect, useRef, useState } from "react";
import { parseLayerDesign } from "@opennan/timeline-core/design/validate";
import type { LayerDesign } from "@opennan/timeline-core/design/model";

const SERVICE = "http://127.0.0.1:4318";
const STEPS: { id: string; label: string }[] = [
    { id: "read_text", label: "Read text" },
    { id: "erase_text", label: "Erase text" },
    { id: "split_layers", label: "Split into layers" },
    { id: "cut_letters", label: "Cut out original letters" },
];

interface Job {
    status: "running" | "done" | "error";
    step: string;
    costUsd: number;
    designUrl?: string;
    error?: string;
}

export interface ImportPanelProps {
    onDesign(design: LayerDesign, base: string): void;
}

export function ImportPanel({ onDesign }: ImportPanelProps) {
    const [online, setOnline] = useState<boolean | null>(null);
    const [job, setJob] = useState<Job | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const timer = useRef<number | undefined>(undefined);

    useEffect(() => {
        fetch(`${SERVICE}/health`).then((r) => r.json()).then((h) => setOnline(Boolean(h.ok && h.falKey))).catch(() => setOnline(false));
        return () => window.clearInterval(timer.current);
    }, []);

    const start = async (file: File) => {
        setError(null);
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
            setError("Choose a PNG, JPEG or WebP image.");
            return;
        }
        setPreview(URL.createObjectURL(file));
        setJob({ status: "running", step: "queued", costUsd: 0 });
        try {
            const r = await fetch(`${SERVICE}/import`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
            const body = await r.json();
            if (!r.ok) throw new Error(body.error ?? `The service answered ${r.status}`);
            timer.current = window.setInterval(async () => {
                const j: Job = await (await fetch(`${SERVICE}/jobs/${body.id}`)).json();
                setJob(j);
                if (j.status === "running") return;
                window.clearInterval(timer.current);
                if (j.status === "done" && j.designUrl) {
                    const design = parseLayerDesign(await (await fetch(j.designUrl)).json());
                    onDesign(design, j.designUrl.replace(/design\.json$/, ""));
                }
            }, 1500);
        } catch (e) {
            setJob(null);
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const stepIndex = job ? STEPS.findIndex((s) => s.id === job.step) : -1;
    const busy = job?.status === "running";

    return (
        <section className="layer-import" aria-label="Create from image">
            <div className="layer-import-head">
                <h2>Create from image</h2>
                <p>Turn any flat image (game UI, slide, poster) into layers you can edit. About 2 minutes and about $0.10 per image on your fal key.</p>
            </div>
            {online === false && (
                <div className="layer-import-offline">
                    <p>The import service is not running. Start it in a terminal:</p>
                    <pre>pip install -r tooling/layer-import/requirements.txt{"\n"}FAL_KEY=your-fal-key python3 tooling/layer-import/serve.py</pre>
                    <p>Then reload this page.</p>
                </div>
            )}
            <div
                className={`layer-import-drop${dragging ? " is-dragging" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f && !busy) void start(f); }}
            >
                {preview ? <img src={preview} alt="Image being imported" /> : <span>Drop an image here</span>}
                <button type="button" disabled={busy || online === false} onClick={() => input.current?.click()}>
                    {busy ? "Working…" : "Choose image"}
                </button>
                <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void start(f); e.target.value = ""; }} />
            </div>
            {job && (
                <ol className="layer-import-steps">
                    {STEPS.map((s, i) => (
                        <li key={s.id} className={job.status === "done" || i < stepIndex ? "is-done" : i === stepIndex && busy ? "is-active" : ""}>{s.label}</li>
                    ))}
                    <li className="layer-import-cost">fal cost so far: ${job.costUsd.toFixed(3)}</li>
                </ol>
            )}
            {job?.status === "done" && <p className="layer-import-ok">Done. The editor above now shows your image as layers.</p>}
            {(error || job?.status === "error") && <p className="layer-import-error">Import failed: {error ?? job?.error}</p>}
        </section>
    );
}

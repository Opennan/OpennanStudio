// Layer tool page (?demo=layers): create a layered design from any image, edit it by hand or with agent ops.
import { useCallback, useEffect, useRef, useState } from "react";
import { LayerEditor, type LayerEditorHandle } from "@opennan/timeline-react";
import { parseLayerDesign } from "@opennan/timeline-core/design/validate";
import type { LayerDesign } from "@opennan/timeline-core/design/model";
import type { DesignOp } from "@opennan/timeline-core/design/ops";
import { ExamplesPanel } from "./examples-panel";
import { ImportPanel } from "./import-panel";
import { SAMPLE_OPS } from "./sample-ops";

const EXAMPLE_BASE = "/layer-demo/";

declare global {
    interface Window {
        __layerDemo?: { apply(ops: DesignOp[]): unknown; describe(): unknown };
    }
}

interface Loaded {
    design: LayerDesign;
    base: string;
    example: boolean;
    /** Remounts the editor (fresh history) when a new design arrives. */
    key: number;
}

/** Fallback fonts of a design, loaded from Google Fonts so the font mode draws with them. */
function useDesignFonts(design: LayerDesign | undefined): string[] {
    const [fonts, setFonts] = useState<string[]>([]);
    useEffect(() => {
        if (!design) return;
        const faces = new Map<string, Set<number>>();
        for (const l of design.layers) if (l.kind === "text") (faces.get(l.style.font) ?? faces.set(l.style.font, new Set()).get(l.style.font)!).add(l.style.weight);
        const families = [...faces].map(([f, w]) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@${[...w].sort().join(";")}`).join("&");
        if (families) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
            document.head.appendChild(link);
        }
        setFonts([...new Set([...faces.keys(), "Roboto", "Inter", "Cinzel", "Kanit"])]);
    }, [design]);
    return fonts;
}

export function LayerDemo() {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [opsText, setOpsText] = useState(JSON.stringify(SAMPLE_OPS[0].ops, null, 2));
    const [result, setResult] = useState("");
    const editor = useRef<LayerEditorHandle>(null);
    const fonts = useDesignFonts(loaded?.design);

    const loadExample = useCallback(() => {
        fetch(`${EXAMPLE_BASE}design.json`)
            .then((r) => r.json())
            .then((j) => setLoaded((p) => ({ design: parseLayerDesign(j), base: EXAMPLE_BASE, example: true, key: (p?.key ?? 0) + 1 })))
            .catch((e) => setError(String(e)));
    }, []);
    useEffect(() => {
        // ?design=/layer-imports/<id>/design.json reopens an earlier import
        const url = new URLSearchParams(location.search).get("design");
        if (!url || !/^\/layer-imports\/[\w-]+\/design\.json$/.test(url)) return loadExample();
        fetch(url)
            .then((r) => r.json())
            .then((j) => setLoaded({ design: parseLayerDesign(j), base: url.replace(/design\.json$/, ""), example: false, key: 1 }))
            .catch((e) => setError(String(e)));
    }, [loadExample]);
    useEffect(() => {
        if (!loaded) return;
        window.__layerDemo = { apply: (ops) => editor.current!.apply(ops), describe: () => editor.current!.describe() };
        setResult("");
    }, [loaded]);

    const run = (ops: DesignOp[]) => {
        const out = editor.current!.apply(ops);
        setResult(JSON.stringify(out.results, null, 2));
    };
    const showRead = () => setResult(JSON.stringify(editor.current!.describe(), null, 2));

    if (error) return <p className="layer-demo-error">Could not load the example design: {error}</p>;
    if (!loaded) return <p className="layer-demo-loading">Loading design…</p>;
    return (
        <main className="opennan-studio layer-demo">
            <header className="layer-demo-header">
                <div>
                    <h1>Layer tool</h1>
                    <p>{loaded.example ? "Example: a flat GPT Image game screen rebuilt into layers." : "Your image, rebuilt into layers."} Drag pieces, double-click text to retype it, or run agent ops below.</p>
                </div>
                <nav>
                    {!loaded.example && <button type="button" onClick={loadExample}>Open the example</button>}
                    <a href="/">Back to the playground</a>
                </nav>
            </header>
            <LayerEditor key={loaded.key} ref={editor} initialDesign={loaded.design} resolveSrc={(s) => loaded.base + s} fonts={fonts} />
            <ImportPanel onDesign={(design, base) => setLoaded((p) => ({ design, base, example: false, key: (p?.key ?? 0) + 1 }))} />
            <section className="layer-demo-agent" aria-label="Agent ops">
                <h2>Try agent ops (what <code>layer_design edit</code> sends)</h2>
                {loaded.example && (
                    <div className="layer-demo-samples">
                        {SAMPLE_OPS.map((s) => (
                            <button key={s.label} type="button" onClick={() => { setOpsText(JSON.stringify(s.ops, null, 2)); run(s.ops); }}>{s.label}</button>
                        ))}
                    </div>
                )}
                <label htmlFor="layer-demo-ops">Ops JSON</label>
                <textarea id="layer-demo-ops" rows={8} value={opsText} onChange={(e) => setOpsText(e.target.value)} />
                <div className="layer-demo-samples">
                    <button type="button" onClick={() => { try { run(JSON.parse(opsText)); } catch (e) { setResult(String(e)); } }}>Run ops</button>
                    <button type="button" onClick={showRead}>Show what read returns</button>
                </div>
                <pre aria-label="Result">{result}</pre>
            </section>
            <ExamplesPanel />
        </main>
    );
}

// What an AI agent sends to the one `layer_design` tool (plan 2), shown next to the editor that runs the same ops.
const EXAMPLES: { title: string; note: string; call: object }[] = [
    {
        title: "1. Import an image (paid, asks first)",
        note: "Without confirm_usd the tool only answers the price. With it, the server holds the money, runs, and charges on success.",
        call: { action: "import", media: "media_8f2c", confirm_usd: 0.25 },
    },
    {
        title: "2. Read the layers",
        note: "Free. Returns groups, layer ids, texts, bounds, and which texts lost their original lettering.",
        call: { action: "read", design_id: "dsg_41a0" },
    },
    {
        title: "3. Edit (any number of ops, one undo step)",
        note: "Free. A target is a layer id, a group id, or the current text.",
        call: {
            action: "edit",
            design_id: "dsg_41a0",
            ops: [
                { op: "set_text", target: "12,450", text: "15,420" },
                { op: "move", target: "G_L5_3", dx: 40, dy: 0 },
                { op: "scale", target: "G_L3_2", factor: 1.15 },
                { op: "set_visible", target: "L1_5", visible: false },
            ],
        },
    },
    {
        title: "4. Redraw missing characters (paid)",
        note: "When read reports missingGlyphs (e.g. a 9 that is not in the image), redraw them in the original style.",
        call: { action: "edit", design_id: "dsg_41a0", ops: [{ op: "redraw_glyphs", target: "385", chars: "9" }], confirm_usd: 0.3 },
    },
    {
        title: "5. Export",
        note: "Free. Renders a PNG into the media library, optionally onto the timeline.",
        call: { action: "export", design_id: "dsg_41a0", place: "timeline" },
    },
];

export function ExamplesPanel() {
    return (
        <section className="layer-examples" aria-label="Tool examples">
            <h2>How the AI uses the tool</h2>
            <p>One MCP tool, <code>layer_design</code>, with an <code>action</code>. Only import and redraw cost money; read, edit and export are free.</p>
            <div className="layer-examples-grid">
                {EXAMPLES.map((e) => (
                    <article key={e.title}>
                        <h3>{e.title}</h3>
                        <p>{e.note}</p>
                        <pre>{JSON.stringify(e.call, null, 2)}</pre>
                    </article>
                ))}
            </div>
        </section>
    );
}

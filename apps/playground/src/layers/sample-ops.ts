// apps/playground/src/layers/sample-ops.ts
// The same op lists an agent sends to `layer_design edit` (plan 2), runnable from the demo.
import type { DesignOp } from "@opennan/timeline-core/design/ops";

export const SAMPLE_OPS: { label: string; ops: DesignOp[] }[] = [
    { label: "Coins → 15,420 (original digits)", ops: [{ op: "set_text", target: "12,450", text: "15,420" }] },
    { label: "Reward → 5,000", ops: [{ op: "set_text", target: "2,500", text: "5,000" }] },
    { label: "Gems → 999 (needs a digit redraw)", ops: [{ op: "set_text", target: "385", text: "999" }] },
    // tile groups of the fixture: G_L5_3 = SHOP (centre 352.5, 501), G_L5_2 = GUILD (centre 700, 500.5)
    { label: "Swap SHOP and GUILD tiles", ops: [{ op: "move", target: "G_L5_3", x: 700, y: 500.5 }, { op: "move", target: "G_L5_2", x: 352.5, y: 501 }] },
    // G_L3_2 = the PLAY button with its shadow and label
    { label: "Make PLAY 15% bigger", ops: [{ op: "scale", target: "G_L3_2", factor: 1.15 }] },
    { label: "Hide the banner", ops: [{ op: "set_visible", target: "L1_5", visible: false }] },
];

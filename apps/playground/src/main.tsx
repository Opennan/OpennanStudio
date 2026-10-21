import "@opennan/timeline-react/styles.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { GoldenApp } from "./golden/golden-app";
import { BenchHarness } from "./harness/bench-harness";
import { ExportHarness } from "./harness/export-harness";
import { LayerDemo } from "./layers/layer-demo";

const params = new URLSearchParams(location.search);
const golden = params.get("golden");
const root = createRoot(document.getElementById("root") as HTMLElement);
if (golden) root.render(<GoldenApp name={golden} />);
else if (params.get("harness") === "export") root.render(<ExportHarness />);
else if (params.get("harness") === "bench") root.render(<BenchHarness />);
else if (params.get("demo") === "layers") root.render(<LayerDemo />);
else root.render(<App />);

import "@opennan/timeline-react/styles.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createStudioRuntime } from "./platform/studio-runtime";

const runtime = createStudioRuntime();

// e2e builds only: the looks parity harness (e2e/gl-parity.spec.ts). Production bundles drop it.
if (import.meta.env.MODE === "e2e") void import("./e2e/looks-harness");

createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <App runtime={runtime} />
    </StrictMode>,
);

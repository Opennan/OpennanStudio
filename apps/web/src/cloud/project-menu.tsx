// The editor's project menu (next to the title): "Save to OpenNan…" for a local project, "Download a local copy"
// for a cloud one. Signed out, Save opens Sign in with OpenNan first.
import { useEffect, useRef, useState } from "react";
import { isCloudProjectId } from "@opennan/cloud-backend";
import { useAccount } from "../account/account-context";
import { useStudioRuntime } from "../platform/runtime-context";
import { DownloadCopyDialog, SaveToCloudDialog } from "./save-dialog";
import "./cloud.css";

export function ProjectMenu({ projectId, projectName }: { projectId: string; projectName: string }) {
    const { cloud } = useStudioRuntime();
    const { account, openSignIn } = useAccount();
    const [open, setOpen] = useState(false);
    const [dialog, setDialog] = useState<"save" | "copy" | null>(null);
    const wrap = useRef<HTMLDivElement>(null);
    const cloudProject = isCloudProjectId(projectId);
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!wrap.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);
    if (!cloud) return null;
    const choose = async (next: "save" | "copy") => {
        setOpen(false);
        if (account.status().state !== "signed-in" && !(await openSignIn({ reason: next === "save" ? "Save this project to OpenNan" : "Download a local copy" }))) return;
        setDialog(next);
    };
    return (
        <div className="project-menu-wrap" ref={wrap}>
            <button type="button" className="button ghost small" aria-haspopup="menu" aria-expanded={open} aria-label="Project menu" onClick={() => setOpen((v) => !v)}>
                Project ▾
            </button>
            {open && (
                <div className="project-menu" role="menu" aria-label="Project">
                    {cloudProject
                        ? <button type="button" role="menuitem" className="project-menu-item" onClick={() => void choose("copy")}>Download a local copy</button>
                        : <button type="button" role="menuitem" className="project-menu-item" onClick={() => void choose("save")}>Save to OpenNan…</button>}
                </div>
            )}
            {dialog === "save" && <SaveToCloudDialog projectId={projectId} projectName={projectName} onClose={() => setDialog(null)} />}
            {dialog === "copy" && <DownloadCopyDialog projectId={projectId} projectName={projectName} onClose={() => setDialog(null)} />}
        </div>
    );
}

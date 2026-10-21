import { useStudioRuntime } from "../platform/runtime-context";
import { useCallback, useRef, useState } from "react";
import { useAccount } from "../account/account-context";
import { CloudProjects } from "../cloud/cloud-projects";
import { SaveToCloudDialog } from "../cloud/save-dialog";
import type { ProjectSummary } from "@opennan/timeline-core";
import { navigate, routeHref } from "../routing/routes";
import { AccountChip } from "../account/account-chip";
import { BrandMark } from "../ui/brand-mark";
import { ConfirmDialog } from "../ui/dialog";
import { formatBytes, formatDuration, formatEdited } from "../ui/format";
import { NewProjectDialog } from "./new-project-dialog";
import { useProjects } from "./use-projects";
import "./projects.css";

const TAB_KEY = "opennan-studio:projects-tab";

function readTab(): "local" | "cloud" {
    try {
        return globalThis.localStorage?.getItem(TAB_KEY) === "cloud" ? "cloud" : "local";
    } catch {
        return "local";
    }
}

export function ProjectListScreen() {
    const { projects, storageInfo, error, create, rename, remove } = useProjects();
    const runtime = useStudioRuntime();
    const desktop = runtime.platform === "desktop";
    const { account, openSignIn } = useAccount();
    const [creating, setCreating] = useState(false);
    const [creatingCloud, setCreatingCloud] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
    const [saving, setSaving] = useState<ProjectSummary | null>(null);
    const [tab, setTabState] = useState<"local" | "cloud">(() => (runtime.cloud ? readTab() : "local"));
    const setTab = (next: "local" | "cloud") => {
        setTabState(next);
        try {
            globalThis.localStorage?.setItem(TAB_KEY, next);
        } catch {
            // private mode
        }
    };
    const cloudCreated = useCallback(() => setCreatingCloud(false), []);
    const startSave = async (project: ProjectSummary) => {
        if (account.status().state !== "signed-in" && !(await openSignIn({ reason: "Save this project to OpenNan" }))) return;
        setSaving(project);
    };

    return (
        <div className="projects">
            <header className="projects-header">
                <div className="brand"><BrandMark className="brand-mark" />OpenNan Studio</div>
                <nav className="projects-nav">
                    <a className="button ghost" href={routeHref({ name: "providers" })}>AI providers</a>
                    <button type="button" className="button primary" onClick={() => (tab === "cloud" ? setCreatingCloud(true) : setCreating(true))}>New project</button>
                    <AccountChip />
                </nav>
            </header>
            <main className="projects-main">
                <h1>Projects</h1>
                {runtime.cloud && (
                    <div className="projects-tabs" role="tablist" aria-label="Where projects live">
                        <button type="button" role="tab" className="projects-tab" aria-selected={tab === "local"} onClick={() => setTab("local")}>On this device</button>
                        <button type="button" role="tab" className="projects-tab" aria-selected={tab === "cloud"} onClick={() => setTab("cloud")}>OpenNan cloud</button>
                    </div>
                )}
                {tab === "cloud" ? <CloudProjects creating={creatingCloud} onCreated={cloudCreated} /> : <>
                <p className="muted">
                    {desktop
                        ? "Projects and media stay on this computer and are never uploaded."
                        : "Projects and media stay in this browser and are never uploaded. The first export downloads the video encoder (about 32 MB) once."}
                </p>
                {storageInfo?.usage && (
                    <p className="muted small" data-testid="storage-usage">
                        Using {formatBytes(storageInfo.usage.usage)} of {formatBytes(storageInfo.usage.quota)} available to this browser.
                    </p>
                )}
                {projects && projects.length > 0 && storageInfo && storageInfo.persist !== "persistent" && (
                    <p role="note" className="storage-warning">
                        This browser may delete these projects when it runs low on space or after a long time without a
                        visit. Export finished videos to keep a copy.
                    </p>
                )}
                {error && <p role="alert" className="error-text">{error}</p>}
                {projects === null ? (
                    <p className="muted">Loading projects…</p>
                ) : projects.length === 0 ? (
                    <div className="projects-empty">
                        <h2>No projects yet</h2>
                        <p className="muted">Start one, import your clips, and export an MP4.</p>
                        <button type="button" className="button primary" onClick={() => setCreating(true)}>New project</button>
                    </div>
                ) : (
                    <ul className="project-grid" aria-label="Projects">
                        {projects.map((project) => (
                            <ProjectCard
                                key={project.id}
                                project={project}
                                renaming={renamingId === project.id}
                                onStartRename={() => setRenamingId(project.id)}
                                onRename={async (name) => {
                                    setRenamingId(null);
                                    if (name && name !== project.name) await rename(project.id, name);
                                }}
                                onCancelRename={() => setRenamingId(null)}
                                onDelete={() => setDeleting(project)}
                                {...(runtime.cloud ? { onSave: () => void startSave(project) } : {})}
                            />
                        ))}
                    </ul>
                )}
                </>}
            </main>
            {saving && <SaveToCloudDialog projectId={saving.id} projectName={saving.name} onClose={() => setSaving(null)} />}
            {creating && (
                <NewProjectDialog
                    onCancel={() => setCreating(false)}
                    onCreate={async (input) => {
                        const project = await create(input);
                        navigate({ name: "editor", projectId: project.id });
                    }}
                />
            )}
            {deleting && (
                <ConfirmDialog
                    title="Delete project?"
                    message={`"${deleting.name}" and its imported media will be removed from ${desktop ? "this computer" : "this browser"}. This cannot be undone.`}
                    confirmLabel="Delete"
                    onCancel={() => setDeleting(null)}
                    onConfirm={async () => {
                        await remove(deleting.id);
                        setDeleting(null);
                    }}
                />
            )}
        </div>
    );
}

function ProjectCard(props: {
    project: ProjectSummary;
    renaming: boolean;
    onStartRename(): void;
    onRename(name: string): Promise<void>;
    onCancelRename(): void;
    onDelete(): void;
    onSave?(): void;
}) {
    const { project } = props;
    const thumb = (
        <span className="project-thumb" aria-hidden="true">
            <span className="project-frame" style={{ aspectRatio: project.aspectRatio.replace(":", " / ") }} />
        </span>
    );
    const details = `${project.aspectRatio} · ${formatDuration(project.durationSeconds)} · ${formatEdited(project.updatedAt)}`;
    return (
        <li className="project-card">
            {props.renaming ? (
                <div className="project-open">
                    {thumb}
                    <RenameField initial={project.name} onSubmit={props.onRename} onCancel={props.onCancelRename} />
                    <span className="project-details">{details}</span>
                </div>
            ) : (
                <a className="project-open" href={routeHref({ name: "editor", projectId: project.id })}>
                    {thumb}
                    <span className="project-name">{project.name}</span>
                    <span className="project-details">{details}</span>
                </a>
            )}
            {props.onSave && (
                <div className="project-save">
                    <button type="button" className="icon-button" aria-label={`Save ${project.name} to OpenNan`} onClick={props.onSave}>Save to OpenNan…</button>
                </div>
            )}
            <div className="project-actions">
                <button type="button" className="icon-button" aria-label={`Rename ${project.name}`} onClick={props.onStartRename}>Rename</button>
                <button type="button" className="icon-button danger" aria-label={`Delete ${project.name}`} onClick={props.onDelete}>Delete</button>
            </div>
        </li>
    );
}

function RenameField({ initial, onSubmit, onCancel }: { initial: string; onSubmit(name: string): Promise<void>; onCancel(): void }) {
    const [value, setValue] = useState(initial);
    const done = useRef(false);
    const finish = (commit: boolean) => {
        if (done.current) return;
        done.current = true;
        if (commit) void onSubmit(value.trim());
        else onCancel();
    };
    return (
        <input
            className="text-input"
            aria-label="Project name"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
                if (event.key === "Enter") finish(true);
                if (event.key === "Escape") finish(false);
            }}
        />
    );
}

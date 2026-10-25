import { useStudioRuntime } from "../platform/runtime-context";
import { useRef, useState } from "react";
import type { ProjectSummary } from "@opennan/timeline-core";
import { navigate, routeHref } from "../routing/routes";
import { AccountChip } from "../account/account-chip";
import { BrandMark } from "../ui/brand-mark";
import { ConfirmDialog } from "../ui/dialog";
import { formatBytes, formatDuration, formatEdited } from "../ui/format";
import { NewProjectDialog } from "./new-project-dialog";
import { useProjects } from "./use-projects";
import "./projects.css";

export function ProjectListScreen() {
    const { projects, storageInfo, error, create, rename, remove } = useProjects();
    const runtime = useStudioRuntime();
    const desktop = runtime.platform === "desktop";
    const [creating, setCreating] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

    return (
        <div className="projects">
            <header className="projects-header">
                <div className="brand"><BrandMark className="brand-mark" />OpenNan Studio</div>
                <nav className="projects-nav">
                    <a className="button ghost" href={routeHref({ name: "providers" })}>AI providers</a>
                    <button type="button" className="button primary" onClick={() => setCreating(true)}>New project</button>
                    <AccountChip />
                </nav>
            </header>
            <main className="projects-main">
                <h1>Projects</h1>
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
                            />
                        ))}
                    </ul>
                )}
            </main>
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

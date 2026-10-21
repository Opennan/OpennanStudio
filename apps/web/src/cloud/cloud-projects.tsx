// The Projects screen's "OpenNan cloud" tab: the account's cloud projects, most recently edited first and paged,
// with thumbnails, sizes and the device that edited last; the trash (restore within 7 days, delete permanently);
// the storage meter. Signed out, it offers Sign in with OpenNan; offline, it shows the last list read.
import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary } from "@opennan/timeline-core";
import { useAccount, useAccountStatus } from "../account/account-context";
import { navigate, routeHref } from "../routing/routes";
import { ConfirmDialog } from "../ui/dialog";
import { formatBytes, formatDuration, formatEdited } from "../ui/format";
import { cloudErrorMessage, deletedIn } from "./cloud-copy";
import { DownloadCopyDialog } from "./save-dialog";
import { StorageMeter } from "./storage-meter";
import { useCloudBackend, useCloudStorage } from "./use-cloud";
import "./cloud.css";

type View = "active" | "deleted";

export function CloudProjects({ creating, onCreated }: { creating: boolean; onCreated(): void }) {
    const { account, openSignIn } = useAccount();
    const status = useAccountStatus(account);
    const backend = useCloudBackend();
    const [view, setView] = useState<View>("active");
    const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [offline, setOffline] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [trashing, setTrashing] = useState<ProjectSummary | null>(null);
    const [purging, setPurging] = useState<ProjectSummary | null>(null);
    const [copying, setCopying] = useState<ProjectSummary | null>(null);
    const storage = useCloudStorage(backend);

    const load = useCallback(async (more = false) => {
        if (!backend) return;
        try {
            const page = await backend.listCloudProjects({ state: view, cursor: more ? cursor : null });
            setProjects((current) => (more && current ? [...current, ...page.projects] : page.projects));
            setCursor(page.nextCursor);
            setOffline(false);
            setError(null);
        } catch (cause) {
            if ((cause as { status?: number }).status === 0) {
                setOffline(true);
                setProjects(await backend.cachedCloudProjects(view));
                setCursor(null);
            } else {
                setError(cloudErrorMessage(cause));
                setProjects((current) => current ?? []);
            }
        }
    }, [backend, view, cursor]);

    useEffect(() => {
        setProjects(null);
        setCursor(null);
        void load(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backend, view]);

    useEffect(() => {
        if (!creating || !backend) return;
        void backend.createProject({ name: "Untitled project" }).then((project) => {
            onCreated();
            navigate({ name: "editor", projectId: project.id });
        }, (cause) => {
            onCreated();
            setError(cloudErrorMessage(cause));
        });
    }, [creating, backend, onCreated]);

    if (status.state !== "signed-in") {
        return (
            <div className="projects-empty cloud-signin" data-testid="cloud-signin">
                <h2>Your OpenNan projects</h2>
                <p className="muted">Sign in to see your OpenNan cloud projects and open them on any device.</p>
                <button type="button" className="button primary" onClick={() => void openSignIn({ reason: "See your OpenNan cloud projects" })}>Sign in with OpenNan</button>
            </div>
        );
    }

    return (
        <div className="cloud-projects">
            <div className="cloud-toolbar">
                <div className="segmented" role="tablist" aria-label="Cloud projects">
                    <button type="button" role="tab" aria-selected={view === "active"} className="segment" onClick={() => setView("active")}>Projects</button>
                    <button type="button" role="tab" aria-selected={view === "deleted"} className="segment" onClick={() => setView("deleted")}>Trash</button>
                </div>
                {offline && <span className="cloud-offline" role="status">Offline · showing the last list read</span>}
            </div>
            {error && <p role="alert" className="error-text">{error}</p>}
            {projects === null ? (
                <p className="muted">Loading cloud projects…</p>
            ) : projects.length === 0 ? (
                <div className="projects-empty">
                    {view === "active" ? (
                        <>
                            <h2>No cloud projects yet</h2>
                            <p className="muted">Save a project to OpenNan from its menu, or start a new one here.</p>
                        </>
                    ) : (
                        <>
                            <h2>The trash is empty</h2>
                            <p className="muted">Projects moved to the trash stay here for 7 days.</p>
                        </>
                    )}
                </div>
            ) : (
                <ul className="project-grid" aria-label={view === "active" ? "Cloud projects" : "Trash"} data-testid={view === "active" ? "cloud-list" : "cloud-trash"}>
                    {projects.map((project) => (
                        <CloudCard
                            key={project.id}
                            project={project}
                            trash={view === "deleted"}
                            onCopy={() => setCopying(project)}
                            onTrash={() => setTrashing(project)}
                            onRestore={async () => {
                                try {
                                    await backend!.restoreProject(project.id);
                                    setProjects((list) => list?.filter((p) => p.id !== project.id) ?? null);
                                } catch (cause) {
                                    setError(cloudErrorMessage(cause));
                                }
                            }}
                            onPurge={() => setPurging(project)}
                        />
                    ))}
                </ul>
            )}
            {cursor && <button type="button" className="button ghost cloud-more" onClick={() => void load(true)}>Load more</button>}
            <section className="cloud-storage" aria-label="Cloud storage">
                <h2 className="cloud-storage-title">Cloud storage</h2>
                <StorageMeter storage={storage.storage} error={storage.error} />
            </section>
            {trashing && (
                <ConfirmDialog
                    title="Move to trash?"
                    message={`"${trashing.name}" is removed from every device. You can restore it from the trash for 7 days.`}
                    confirmLabel="Move to trash"
                    onCancel={() => setTrashing(null)}
                    onConfirm={async () => {
                        try {
                            await backend!.deleteProject(trashing.id);
                            setProjects((list) => list?.filter((p) => p.id !== trashing.id) ?? null);
                        } catch (cause) {
                            setError(cloudErrorMessage(cause));
                        }
                        setTrashing(null);
                    }}
                />
            )}
            {purging && (
                <ConfirmDialog
                    title="Delete permanently?"
                    message={`"${purging.name}" and its cloud data are deleted now. This cannot be undone.`}
                    confirmLabel="Delete permanently"
                    onCancel={() => setPurging(null)}
                    onConfirm={async () => {
                        try {
                            await backend!.deleteProjectPermanently(purging.id);
                            setProjects((list) => list?.filter((p) => p.id !== purging.id) ?? null);
                        } catch (cause) {
                            setError(cloudErrorMessage(cause));
                        }
                        setPurging(null);
                    }}
                />
            )}
            {copying && <DownloadCopyDialog projectId={copying.id} projectName={copying.name} onClose={() => setCopying(null)} />}
        </div>
    );
}

function CloudCard({ project, trash, onCopy, onTrash, onRestore, onPurge }: {
    project: ProjectSummary;
    trash: boolean;
    onCopy(): void;
    onTrash(): void;
    onRestore(): Promise<void>;
    onPurge(): void;
}) {
    const [thumbFailed, setThumbFailed] = useState(false);
    const thumb = (
        <span className="project-thumb" aria-hidden="true">
            {project.thumbnailUrl && !thumbFailed
                ? <img className="cloud-thumb" src={project.thumbnailUrl} alt="" onError={() => setThumbFailed(true)} />
                : <span className="project-frame" style={{ aspectRatio: project.aspectRatio.replace(":", " / ") }} />}
        </span>
    );
    const size = project.mediaBytes ? ` · ${formatBytes(project.mediaBytes)}` : "";
    const details = `${formatDuration(project.durationSeconds)} · ${project.aspectRatio}${size}`;
    const where = trash
        ? deletedIn(project.deletedAt)
        : project.origin === "web" ? "Made on opennan.com"
            : `${formatEdited(project.updatedAt)}${project.lastEditedDevice ? ` on ${project.lastEditedDevice}` : ""}`;
    return (
        <li className="project-card cloud-card" data-testid="cloud-card">
            {trash ? (
                <div className="project-open">
                    {thumb}
                    <span className="project-name">{project.name}</span>
                    <span className="project-details">{details}</span>
                    <span className="project-details">{where}</span>
                </div>
            ) : (
                <a className="project-open" href={routeHref({ name: "editor", projectId: project.id })}>
                    {thumb}
                    <span className="project-name">{project.name}</span>
                    <span className="project-details">{details}</span>
                    <span className="project-details">{where}</span>
                </a>
            )}
            <div className="project-actions">
                {trash ? (
                    <>
                        <button type="button" className="icon-button" aria-label={`Restore ${project.name}`} onClick={() => void onRestore()}>Restore</button>
                        <button type="button" className="icon-button danger" aria-label={`Delete ${project.name} permanently`} onClick={onPurge}>Delete permanently</button>
                    </>
                ) : (
                    <>
                        <button type="button" className="icon-button" aria-label={`Download a local copy of ${project.name}`} onClick={onCopy}>Download a local copy</button>
                        <button type="button" className="icon-button danger" aria-label={`Move ${project.name} to trash`} onClick={onTrash}>Move to trash</button>
                    </>
                )}
            </div>
        </li>
    );
}

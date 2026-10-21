// OpenNan cloud project tools (phase 9a): over the host's cloud runtime (StudioSession.cloud: the desktop app signed
// in to OpenNan). Edits an agent makes afterwards run on the editor's controller, so on a cloud project they sync
// and undo per device like the person's own; the server's project-wide undo is never used.
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import type { StudioCloudProject, StudioShareLink } from "../session";
import type { ToolHandler } from "./types";

export const CLOUD_UNAVAILABLE = "OpenNan cloud projects need the OpenNan Studio app signed in to OpenNan (headless `mcp serve` has none).";

function duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function size(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function row(project: StudioCloudProject): Record<string, unknown> {
    return {
        id: project.id, name: project.name, aspect_ratio: project.aspectRatio, duration_seconds: project.durationSeconds, media_bytes: project.mediaBytes,
        updated_at: project.updatedAt ? new Date(project.updatedAt).toISOString() : null, last_edited_device: project.lastEditedDevice, origin: project.origin,
        ...(project.deletedAt ? { deleted_at: new Date(project.deletedAt).toISOString() } : {}),
    };
}

async function guarded(work: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    try {
        return await work();
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
}

const listCloudProjects: ToolHandler = async (args, { session }) => {
    const cloud = session.cloud;
    if (!cloud) return unavailable(CLOUD_UNAVAILABLE);
    return guarded(async () => {
        const trash = args.trash === true;
        const page = await cloud.listProjects({ trash, cursor: typeof args.cursor === "string" ? args.cursor : null });
        const lines = page.projects.map((p) => `- ${p.name} (${p.id}): ${duration(p.durationSeconds)}, ${p.aspectRatio}, ${size(p.mediaBytes)}${p.lastEditedDevice ? `, last edited on ${p.lastEditedDevice}` : p.origin === "web" ? ", made on opennan.com" : ""}`);
        const head = page.projects.length === 0 ? (trash ? "The trash is empty." : "No cloud projects yet.") : `${page.projects.length} ${trash ? "projects in the trash" : "cloud projects"}:`;
        return success([head, ...lines, ...(page.nextCursor ? ["More: call again with cursor."] : [])].join("\n"), { projects: page.projects.map(row), next_cursor: page.nextCursor });
    });
};

const saveProjectToCloud: ToolHandler = async (_args, { session }) => {
    const cloud = session.cloud;
    if (!cloud) return unavailable(CLOUD_UNAVAILABLE);
    if (session.projectId.startsWith("cloud-")) return failure("The open project is already an OpenNan cloud project.");
    return guarded(async () => {
        const saved = await cloud.saveCurrentProject();
        return success(`Saved "${saved.name}" to OpenNan as ${saved.projectId}; the editor now shows the cloud project and its edits sync to every device.`, { project_id: saved.projectId, name: saved.name });
    });
};

const openCloudProject: ToolHandler = async (args, { session }) => {
    const cloud = session.cloud;
    if (!cloud) return unavailable(CLOUD_UNAVAILABLE);
    const projectId = String(args.project_id ?? "");
    if (!/^cloud-[A-Za-z0-9_-]{1,36}$/.test(projectId)) return failure("project_id must be a cloud project id from list_cloud_projects (\"cloud-…\").");
    return guarded(async () => {
        const opened = await cloud.openProject(projectId);
        return success(`Opened "${opened.name}".`, { project_id: opened.projectId, name: opened.name });
    });
};

const getCloudSyncStatus: ToolHandler = async (args, { session }) => {
    const cloud = session.cloud;
    if (!cloud) return unavailable(CLOUD_UNAVAILABLE);
    return guarded(async () => {
        const status = await cloud.syncStatus(typeof args.project_id === "string" ? args.project_id : undefined);
        if (!status) return failure("That project is not an OpenNan cloud project (local projects never sync).");
        const conflicts = status.conflicts.length > 0 ? `\nNot applied:\n${status.conflicts.map((c) => `- ${c}`).join("\n")}` : "";
        return success(`${status.label}${conflicts}`, { project_id: status.projectId, state: status.state, label: status.label, pending: status.pending, conflicts: status.conflicts });
    });
};

// ── share links (phase 9c) ─────────────────────────────────────────────

export const SHARE_NEEDS_APP = "Creating a share link needs the OpenNan Studio app open with this project: it asks you before an agent makes a public link, and headless `mcp serve` has no window to ask in.";
export const SHARE_DECLINED = "The person declined in OpenNan Studio, so no share link was made. Don't ask again unless they want one: they can also make it themselves with Share.";
export const SHARE_UNANSWERED = "No one answered in OpenNan Studio within 2 minutes (that counts as declined), so no share link was made.";

/**
 * Thrown by a host's StudioCloudShares.create when the person did not allow an agent's public link (9c.1): they
 * declined, or left the question unanswered for 2 minutes.
 */
export class ShareNotAllowedError extends Error {
    constructor(readonly reason: "declined" | "unanswered") {
        super(reason === "declined" ? SHARE_DECLINED : SHARE_UNANSWERED);
        this.name = "ShareNotAllowedError";
    }
}

export const SHARE_NEEDS_CLOUD = "Share links need a cloud project: save it to OpenNan first (save_project_to_cloud). Local projects stay on this device.";
export const SHARE_UNAVAILABLE = "Share links need the OpenNan Studio app signed in to OpenNan.";
const SHARE_ID = /^shr_[0-9a-f]{24}$/;

function isoOf(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
}

function shareRow(link: StudioShareLink): Record<string, unknown> {
    return {
        share_id: link.id, url: link.url, status: link.status, allow_download: link.allowDownload, expires_at: isoOf(link.expiresAt), created_at: isoOf(link.createdAt),
        revoked_at: isoOf(link.revokedAt), views: link.views, last_viewed_at: isoOf(link.lastViewedAt),
    };
}

function shareLine(link: StudioShareLink): string {
    const views = `${link.views} view${link.views === 1 ? "" : "s"}${link.lastViewedAt ? `, last ${isoOf(link.lastViewedAt)!.slice(0, 16).replace("T", " ")} UTC` : ""}`;
    if (link.status === "active") return `- Active (${link.id}): ${link.url} · until ${isoOf(link.expiresAt)?.slice(0, 10) ?? "?"} · ${link.allowDownload ? "download allowed" : "watch only"} · ${views}`;
    return `- ${link.status === "revoked" ? "Turned off" : "Expired"} (${link.id}) · ${views}`;
}

/** The share seam of a cloud project, or the outcome to answer instead. */
function sharesOf(session: Parameters<ToolHandler>[1]["session"]) {
    const cloud = session.cloud;
    if (!cloud) return { outcome: unavailable(CLOUD_UNAVAILABLE) };
    if (!session.projectId.startsWith("cloud-")) return { outcome: failure(SHARE_NEEDS_CLOUD) };
    if (!cloud.shares) return { outcome: unavailable(SHARE_UNAVAILABLE) };
    return { shares: cloud.shares };
}

const createShareLink: ToolHandler = async (args, { session, signal }) => {
    if (!session.cloud) return unavailable(SHARE_NEEDS_APP);
    const found = sharesOf(session);
    if (!found.shares) return found.outcome!;
    const days = args.expires_in_days;
    if (days !== undefined && !(typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365)) return failure("expires_in_days is a whole number of days from 1 to 365.");
    if (args.allow_download !== undefined && typeof args.allow_download !== "boolean") return failure("allow_download is true or false.");
    const shares = found.shares;
    return guarded(async () => {
        let link: StudioShareLink;
        try {
            link = await shares.create({ ...(days !== undefined ? { expiresInDays: days } : {}), ...(args.allow_download !== undefined ? { allowDownload: args.allow_download as boolean } : {}) }, { signal });
        } catch (error) {
            if (error instanceof ShareNotAllowedError) return failure(error.message, { declined: true, reason: error.reason });
            throw error;
        }
        return success(
            `Share link (view only${link.allowDownload ? ", download allowed" : ""}, works until ${isoOf(link.expiresAt)?.slice(0, 10) ?? "?"}): ${link.url}\nAny earlier link of this project no longer works.`,
            shareRow(link),
        );
    });
};

const listShareLinks: ToolHandler = async (_args, { session }) => {
    const found = sharesOf(session);
    if (!found.shares) return found.outcome!;
    const shares = found.shares;
    return guarded(async () => {
        const links = await shares.list();
        const head = links.some((l) => l.status === "active") ? "The project is shared:" : links.length > 0 ? "The project is not shared now. Earlier links:" : "The project is not shared (no links yet).";
        return success([head, ...links.map(shareLine)].join("\n"), { links: links.map(shareRow) });
    });
};

const revokeShareLink: ToolHandler = async (args, { session }) => {
    const found = sharesOf(session);
    if (!found.shares) return found.outcome!;
    const id = args.share_id;
    if (id !== undefined && (typeof id !== "string" || !SHARE_ID.test(id))) return failure("share_id must be a link's id from list_share_links (shr_…).");
    const shares = found.shares;
    return guarded(async () => {
        const revoked = await shares.revoke(id as string | undefined);
        // OpenNan answers exactly the links it turned off (9c.1): name them.
        const ids = revoked.map((l) => l.id);
        const text = revoked.length === 0 ? "There was no active link: nothing to turn off."
            : revoked.length === 1 ? `Turned off the link ${ids[0]}: people who have it can no longer watch.`
                : `Turned off ${revoked.length} links (${ids.join(", ")}): people who have them can no longer watch.`;
        return success(text, { links: revoked.map(shareRow) });
    });
};

export const CLOUD_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    list_cloud_projects: listCloudProjects,
    save_project_to_cloud: saveProjectToCloud,
    open_cloud_project: openCloudProject,
    get_cloud_sync_status: getCloudSyncStatus,
    create_share_link: createShareLink,
    list_share_links: listShareLinks,
    revoke_share_link: revokeShareLink,
};

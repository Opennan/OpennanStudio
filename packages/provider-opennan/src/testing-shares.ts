// The fake OpenNan server's share links (phase 9c), Node only, wired into the fake cloud (testing-cloud.ts):
// transcribed from the server's share link routes. Owner routes (the key's account, the project live):
//   POST   /v1/projects/{id}/shares            create, or rotate the active link ({expires_in_days 1-365 = 30, allow_download = false})
//   GET    /v1/projects/{id}/shares            the project's links, newest first, at most 20
//   DELETE /v1/projects/{id}/shares            stop sharing: revokes the active links only and answers exactly those
//   DELETE /v1/projects/{id}/shares/{shr_…}    revoke one (again: no change)
// Public routes (no key): GET /v1/shares/{token} (re-checked on every view, counted, "signed" media URLs, privacy
// headers) and POST /v1/shares/{token}/reports. Every project_share names share_base_url (`<site>/s`; GET /v1/account
// too) and its url is `<share_base_url>/<token>`; only links made count against the hour (a refused create never
// does). Knobs: share-limits {max_active?, creates_per_hour?}, share-expire {share_id}, share-base-url {value: string |
// null} (null: an older server that names no base).
import { randomBytes } from "node:crypto";
import { FakeCloudError, type CloudAnswer } from "./testing-cloud";

export const SHARE_DEFAULT_DAYS = 30;
export const SHARE_MAX_DAYS = 365;
export const SHARE_MAX_ACTIVE = 50;
export const SHARE_CREATES_PER_HOUR = 30;
const MAX_LISTED = 20;
const MAX_SCENES = 200;
const MIN_MEDIA_SECONDS = 15 * 60;
const MAX_MEDIA_SECONDS = 3 * 3600;
const OWNER_FALLBACK = "An OpenNan creator";
const REASONS = ["spam", "sexual", "violence", "hate", "harassment", "copyright", "privacy", "illegal", "other"] as const;
const SHARE_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const SHARE_ID = /^shr_[0-9a-f]{24}$/;

/** What the share routes read of a project (FakeCloudServer answers it). */
export interface FakeShareProject {
    id: string;
    name: string;
    aspectRatio: string;
    durationSeconds: number;
    finalVideoUrl: string | null;
    trashed: boolean;
    /** Scenes in timeline order (track, position, order). */
    scenes: Array<{ duration: number; videoUrl: string | null; imageUrl: string | null }>;
}

export interface FakeShareState {
    id: string;
    project_id: string;
    token: string;
    allow_download: boolean;
    expires_at: string;
    created_at: string;
    revoked_at: string | null;
    views: number;
    last_viewed_at: string | null;
    reports: number;
}

interface StoredShare {
    id: string;
    projectId: string;
    token: string;
    allowDownload: boolean;
    expiresAt: number;
    createdAt: number;
    revokedAt: number | null;
    views: number;
    lastViewedAt: number | null;
    reports: number;
}

export interface FakeShareDeps {
    base(): string;
    /** The project when it exists (trashed included); null when it does not. */
    project(id: string): FakeShareProject | null;
    ownerName(): string | null;
}

interface Request { method: string; path: string; body: unknown }

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const invalid = (message: string) => new FakeCloudError(400, "invalid_request_error", message, "invalid_request");

export function createFakeShares(deps: FakeShareDeps) {
    let shares = new Map<string, StoredShare>();
    let creates: number[] = [];
    let limits = { maxActive: SHARE_MAX_ACTIVE, createsPerHour: SHARE_CREATES_PER_HOUR };
    let lastTick = 0;
    /** undefined: `<site>/s`; null: an older server (no share_base_url; urls still on the fake's site). */
    let baseOverride: string | null | undefined;
    const shareBase = (): string | null => (baseOverride === undefined ? `${deps.base()}/s` : baseOverride);
    const now = () => (lastTick = Math.max(Date.now(), lastTick + 1));

    const status = (s: StoredShare) => (s.revokedAt !== null ? "revoked" : Date.now() >= s.expiresAt ? "expired" : "active");
    const live = (s: StoredShare) => s.revokedAt === null && s.expiresAt > Date.now();
    const ours = (url: string | null | undefined): url is string => typeof url === "string" && url.startsWith(`${deps.base()}/files/`) && !url.includes("/uploads/temp/");

    function view(s: StoredShare): Record<string, unknown> {
        const base = shareBase();
        return {
            object: "project_share", id: s.id, project_id: s.projectId, token: s.token, url: `${base ?? `${deps.base()}/s`}/${s.token}`, ...(base !== null ? { share_base_url: base } : {}), status: status(s),
            allow_download: s.allowDownload, expires_at: iso(s.expiresAt), created_at: iso(s.createdAt), revoked_at: s.revokedAt === null ? null : iso(s.revokedAt),
            views: s.views, last_viewed_at: s.lastViewedAt === null ? null : iso(s.lastViewedAt),
        };
    }

    function owned(projectId: string): FakeShareProject {
        const p = deps.project(projectId);
        if (!p || p.trashed) throw new FakeCloudError(404, "not_found", "No such project on this account.", "not_found");
        return p;
    }

    function parseBody(body: unknown): { days: number; allowDownload: boolean } {
        const raw = body === undefined || body === null ? {} : body;
        if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("body: Input should be a valid dictionary");
        const b = raw as Record<string, unknown>;
        const extra = Object.keys(b).find((k) => k !== "expires_in_days" && k !== "allow_download");
        if (extra) throw invalid(`body.${extra}: Extra inputs are not permitted`);
        let days = SHARE_DEFAULT_DAYS;
        if (b.expires_in_days !== undefined) {
            if (typeof b.expires_in_days !== "number" || !Number.isInteger(b.expires_in_days)) throw invalid("body.expires_in_days: Input should be a valid integer");
            if (b.expires_in_days < 1) throw invalid("body.expires_in_days: Input should be greater than or equal to 1");
            if (b.expires_in_days > SHARE_MAX_DAYS) throw invalid(`body.expires_in_days: Input should be less than or equal to ${SHARE_MAX_DAYS}`);
            days = b.expires_in_days;
        }
        if (b.allow_download !== undefined && typeof b.allow_download !== "boolean") throw invalid("body.allow_download: Value error, must be true or false");
        return { days, allowDownload: b.allow_download === true };
    }

    function create(projectId: string, body: unknown): CloudAnswer {
        const options = parseBody(body);
        const hourAgo = Date.now() - 3_600_000;
        creates = creates.filter((t) => t > hourAgo);
        if (creates.length >= limits.createsPerHour) {
            const wait = Math.max(1, Math.ceil((creates[0]! + 3_600_000 - Date.now()) / 1000));
            throw new FakeCloudError(429, "rate_limit_error", `Too many share links created: at most ${limits.createsPerHour} per hour per account. Try again in ${wait}s.`, "rate_limit_exceeded", undefined, { "retry-after": String(wait) });
        }
        const p = owned(projectId);
        const hasMedia = ours(p.finalVideoUrl) || p.scenes.some((s) => ours(s.videoUrl) || ours(s.imageUrl));
        if (!hasMedia) throw new FakeCloudError(409, "conflict", "This project has nothing to show yet: export it or add a scene with a video or picture first.", "share_nothing_to_show");
        const replaced = [...shares.values()].filter((s) => s.projectId === projectId && live(s)).map((s) => s.id);
        const others = [...shares.values()].filter((s) => s.projectId !== projectId && live(s)).length;
        if (others >= limits.maxActive) throw new FakeCloudError(409, "conflict", `An account can have at most ${limits.maxActive} active share links: turn one off first.`, "share_limit_reached");
        const at = now();
        for (const id of replaced) shares.get(id)!.revokedAt = at;
        const share: StoredShare = {
            id: `shr_${randomBytes(12).toString("hex")}`, projectId, token: randomBytes(36).toString("base64url"), allowDownload: options.allowDownload,
            expiresAt: at + options.days * 86_400_000, createdAt: at, revokedAt: null, views: 0, lastViewedAt: null, reports: 0,
        };
        shares.set(share.id, share);
        // Counted once the link is made: a refused create never uses one of the hour's.
        creates.push(Date.now());
        return { status: 201, json: { ...view(share), replaced } };
    }

    const ofProject = (projectId: string) => [...shares.values()].filter((s) => s.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

    /** The owner's routes; null when the path is not one. */
    function owner(req: Request): CloudAnswer | null {
        const match = /^\/v1\/projects\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(req.path);
        if (!match) return null;
        const projectId = decodeURIComponent(match[1]!);
        const shareId = match[2] === undefined ? null : decodeURIComponent(match[2]);
        if (!/^[A-Za-z0-9_-]{1,36}$/.test(projectId)) throw invalid("project_id: String should match pattern '^[A-Za-z0-9_-]{1,36}$'");
        if (shareId === null) {
            if (req.method === "POST") return create(projectId, req.body);
            if (req.method === "GET") {
                owned(projectId);
                return { status: 200, json: { object: "list", data: ofProject(projectId).slice(0, MAX_LISTED).map(view) } };
            }
            if (req.method === "DELETE") {
                owned(projectId);
                // Active links only (expired ones stay expired), answered exactly.
                const at = now();
                const active = ofProject(projectId).filter(live);
                for (const s of active) s.revokedAt = at;
                return { status: 200, json: { object: "list", data: active.map(view) } };
            }
            return null;
        }
        if (req.method !== "DELETE") return null;
        if (!SHARE_ID.test(shareId)) throw invalid("share_id: String should match pattern '^shr_[0-9a-f]{24}$'");
        owned(projectId);
        const share = shares.get(shareId);
        if (!share || share.projectId !== projectId) throw new FakeCloudError(404, "not_found", "No such share link on this project.", "not_found");
        if (share.revokedAt === null) share.revokedAt = now();
        return { status: 200, json: view(share) };
    }

    function refused(code: "share_not_found" | "share_expired" | "share_revoked" | "share_unavailable"): FakeCloudError {
        const [status, type, message] = {
            share_not_found: [404, "not_found", "This share link does not exist."],
            share_expired: [410, "gone", "This share link has expired."],
            share_revoked: [410, "gone", "The owner turned this share link off."],
            share_unavailable: [410, "gone", "This shared video is no longer available."],
        }[code] as [number, string, string];
        return new FakeCloudError(status, type, message, code, undefined, { ...SHARE_HEADERS });
    }

    function signed(url: string | null, seconds: number, download?: string): string | null {
        if (!ours(url)) return null;
        const expires = Math.floor(Date.now() / 1000) + seconds;
        return `${url}?X-Fake-Expires=${expires}&X-Fake-Signature=${randomBytes(8).toString("hex")}${download ? `&response-content-disposition=${encodeURIComponent(`attachment; filename="${download}"`)}` : ""}`;
    }

    /** The public routes (no key); null when the path is not one. */
    function publicRoute(req: Request): CloudAnswer | null {
        const match = /^\/v1\/shares\/([^/]+)(\/reports)?$/.exec(req.path);
        if (!match) return null;
        const token = decodeURIComponent(match[1]!);
        if (!TOKEN.test(token)) throw invalid("token: String should match pattern '^[A-Za-z0-9_-]{20,64}$'");
        const share = [...shares.values()].find((s) => s.token === token);
        if (match[2]) {
            if (req.method !== "POST") return null;
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (typeof b !== "object" || !REASONS.includes(b.reason as (typeof REASONS)[number])) throw invalid(`body.reason: Input should be ${REASONS.map((r) => `'${r}'`).join(", ")}`);
            if (b.details !== undefined && b.details !== null && (typeof b.details !== "string" || b.details.length > 1_000)) throw invalid("body.details: String should have at most 1000 characters");
            if (!share) throw refused("share_not_found");
            share.reports += 1;
            return { status: 202, json: { object: "share_report", received: true }, headers: { ...SHARE_HEADERS } };
        }
        if (req.method !== "GET") return null;
        if (!share) throw refused("share_not_found");
        if (share.revokedAt !== null) throw refused("share_revoked");
        if (Date.now() >= share.expiresAt) throw refused("share_expired");
        const p = deps.project(share.projectId);
        if (!p || p.trashed) throw refused("share_unavailable");
        const seconds = Math.min(MAX_MEDIA_SECONDS, Math.max(MIN_MEDIA_SECONDS, Math.ceil(2 * Math.max(0, p.durationSeconds)) + 600));
        const title = p.name || "Untitled";
        let video: Record<string, unknown> | null = null;
        const url = signed(p.finalVideoUrl, seconds);
        if (url) {
            video = { url };
            if (share.allowDownload) video.download_url = signed(p.finalVideoUrl, seconds, `${title.replace(/[/\\:*?"<>|]/g, "").slice(0, 80) || "video"}.mp4`);
        }
        const scenes: Array<Record<string, unknown>> = [];
        if (!video) {
            for (const scene of p.scenes) {
                const videoUrl = signed(scene.videoUrl, seconds);
                const imageUrl = videoUrl ? null : signed(scene.imageUrl, seconds);
                if (videoUrl || imageUrl) scenes.push({ duration: scene.duration, video_url: videoUrl, image_url: imageUrl });
                if (scenes.length >= MAX_SCENES) break;
            }
        }
        share.views += 1;
        share.lastViewedAt = now();
        return {
            status: 200, headers: { ...SHARE_HEADERS },
            json: {
                object: "shared_project", title, owner_name: deps.ownerName() || OWNER_FALLBACK, aspect_ratio: p.aspectRatio || "16:9",
                duration_seconds: Math.round(p.durationSeconds * 1000) / 1000, allow_download: share.allowDownload, expires_at: iso(share.expiresAt),
                media_expires_at: iso(Date.now() + seconds * 1000), video, scenes,
            },
        };
    }

    function knob(name: string, body: unknown): CloudAnswer | null {
        const b = (body ?? {}) as Record<string, unknown>;
        if (name === "share-limits") {
            for (const [k, v] of Object.entries(b)) {
                if ((k !== "max_active" && k !== "creates_per_hour") || typeof v !== "number" || !Number.isInteger(v) || v < 0) return invalid("max_active and creates_per_hour are counts").answer();
            }
            if (typeof b.max_active === "number") limits.maxActive = b.max_active;
            if (typeof b.creates_per_hour === "number") limits.createsPerHour = b.creates_per_hour;
            return { status: 200, json: { max_active: limits.maxActive, creates_per_hour: limits.createsPerHour } };
        }
        if (name === "share-base-url") {
            if (b.value !== null && (typeof b.value !== "string" || !/^https?:\/\/[^\s]+$/.test(b.value))) return invalid("value is a base URL or null").answer();
            baseOverride = b.value as string | null;
            return { status: 200, json: { share_base_url: shareBase() } };
        }
        if (name === "share-expire") {
            const share = typeof b.share_id === "string" ? shares.get(b.share_id) : undefined;
            if (!share) return invalid("share_id must name a share link").answer();
            share.expiresAt = Date.now() - 1000;
            return { status: 200, json: view(share) };
        }
        return null;
    }

    return {
        owner,
        publicRoute,
        knob,
        /** GET /v1/account's share_base_url (null: an older server that names none). */
        shareBaseUrl: shareBase,
        /** A project deleted for good deletes its links. */
        purge(projectId: string) {
            for (const [id, s] of shares) if (s.projectId === projectId) shares.delete(id);
        },
        state(): FakeShareState[] {
            return [...shares.values()].map((s) => ({
                id: s.id, project_id: s.projectId, token: s.token, allow_download: s.allowDownload, expires_at: iso(s.expiresAt), created_at: iso(s.createdAt),
                revoked_at: s.revokedAt === null ? null : iso(s.revokedAt), views: s.views, last_viewed_at: s.lastViewedAt === null ? null : iso(s.lastViewedAt), reports: s.reports,
            }));
        },
        reset() {
            shares = new Map();
            creates = [];
            limits = { maxActive: SHARE_MAX_ACTIVE, createsPerHour: SHARE_CREATES_PER_HOUR };
            baseOverride = undefined;
        },
    };
}

export type FakeShares = ReturnType<typeof createFakeShares>;

// Ids LocalBackend and the main process create with crypto.randomUUID() (lower case). Anything else that
// claims to be an id (from the renderer, a database row, a URL) is refused before it reaches a path.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID.test(value);
}

/** OpenNan cloud projects' Studio ids (phase 9a): "cloud-" + the server's id, whose characters are safe in file names. */
export const CLOUD_PROJECT_ID = /^cloud-[A-Za-z0-9_-]{1,36}$/;

/** A project the editor can open: a local project's UUID or a cloud project's "cloud-<server id>". */
export function isProjectRef(value: unknown): value is string {
    return typeof value === "string" && (UUID.test(value) || CLOUD_PROJECT_ID.test(value));
}

// The desktop store: one SQLite file (better-sqlite3) with versioned migrations. Projects keep
// LocalProjectState as JSON (LocalBackend writes whole documents); media rows map upload ids to files;
// settings and encrypted secrets are key/value rows.
import Database from "better-sqlite3";

export type DesktopDatabase = Database.Database;

/** MIGRATIONS[n] upgrades schema n to n + 1. Append only. */
export const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE projects (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE media (
        id TEXT PRIMARY KEY, project_id TEXT, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        original_name TEXT NOT NULL, duration_seconds REAL, created_at INTEGER NOT NULL
    );
    CREATE INDEX media_project ON media(project_id);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE secrets (name TEXT PRIMARY KEY, cipher BLOB NOT NULL, updated_at INTEGER NOT NULL);
    `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DesktopDatabase {
    const db = new Database(file);
    try {
        if (file !== ":memory:") db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        const version = db.pragma("user_version", { simple: true }) as number;
        if (version > SCHEMA_VERSION) {
            throw new Error(`This database was written by a newer OpenNan Studio (schema ${version})`);
        }
        for (let step = version; step < SCHEMA_VERSION; step += 1) {
            db.transaction(() => {
                db.exec(MIGRATIONS[step]);
                db.pragma(`user_version = ${step + 1}`);
            })();
        }
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

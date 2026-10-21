import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, openDatabase } from "./database";

const tables = (db: Database.Database) =>
    (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>).map((r) => r.name);

describe("openDatabase", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-db-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("creates the schema", () => {
        const db = openDatabase(":memory:");
        expect(tables(db)).toEqual(["media", "projects", "secrets", "settings"]);
        expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
        db.close();
    });

    it("keeps data across reopen and does not migrate twice", () => {
        const file = path.join(dir, "store.sqlite");
        const first = openDatabase(file);
        expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
        first.prepare("insert into settings values (?, ?)").run("k", "\"v\"");
        first.close();
        const second = openDatabase(file);
        expect(second.prepare("select value from settings where key = 'k'").get()).toEqual({ value: "\"v\"" });
        second.close();
    });

    it("refuses a database from a newer app", () => {
        const file = path.join(dir, "newer.sqlite");
        const raw = new Database(file);
        raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
        raw.close();
        expect(() => openDatabase(file)).toThrow(`This database was written by a newer OpenNan Studio (schema ${SCHEMA_VERSION + 1})`);
    });
});

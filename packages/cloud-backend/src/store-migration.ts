// Moving an account's on-device cloud state to a new store key (phase 9a.1): the store was keyed by the account's
// email until /v1/account had a stable account id. migrateStore copies every record the target does not have yet
// (the target's own records are newer and win), then deletes it from the source; it is idempotent, so a run a crash
// interrupted finishes on the next start.
//
// migratingStore holds every call to the target until that move (and the old backend's last writes) finished. Records
// another tab is still using (`skip`: web, a cloud project open in a tab that still runs on the email key) are left
// where they are and moved on the first read once they are free; a record a failed or interrupted move left behind
// is read from the old store the same way, so the target is never read half-moved. A delete reaches both stores, so a
// forgotten project never comes back from the old one.
import { STORE_NAMESPACES, type CloudStore, type StoreNamespace } from "./store";

export interface MigrationOptions {
    /** The old backend's dispose: nothing moves before its last writes landed. */
    waitFor?: Promise<unknown>;
    /** True for a record another context is using now (it stays in the old store until it is free). */
    skip?(namespace: StoreNamespace, key: string): Promise<boolean>;
    logger?: { warn(...args: unknown[]): void };
}

export async function migrateStore(from: CloudStore, to: CloudStore, skip?: MigrationOptions["skip"]): Promise<{ moved: number; left: number }> {
    let moved = 0;
    let left = 0;
    for (const namespace of STORE_NAMESPACES) {
        for (const key of await from.keys(namespace)) {
            if (await skip?.(namespace, key)) {
                left += 1;
                continue;
            }
            if (await moveOne(from, to, namespace, key)) moved += 1;
        }
    }
    return { moved, left };
}

/** Moves one record (the target's own copy wins); true when it was copied. */
async function moveOne(from: CloudStore, to: CloudStore, namespace: StoreNamespace, key: string): Promise<boolean> {
    const value = await from.get(namespace, key);
    let copied = false;
    if (value !== null && (await to.get(namespace, key)) === null) {
        await to.put(namespace, key, value);
        copied = true;
    }
    await from.delete(namespace, key);
    return copied;
}

export function migratingStore(target: CloudStore, from: CloudStore | null, options: MigrationOptions = {}): CloudStore {
    if (!from) return target;
    let ready: Promise<void> | null = null;
    const migrated = () => (ready ??= (async () => {
        await options.waitFor?.catch(() => undefined);
        try {
            await migrateStore(from, target, options.skip);
        } catch (error) {
            // What did not move is read from the old store record by record, and moves then.
            options.logger?.warn("[cloud] moving this account's cloud state to its account id failed", error);
        }
    })());
    const skipped = async (namespace: StoreNamespace, key: string) => {
        try {
            return (await options.skip?.(namespace, key)) ?? false;
        } catch {
            return true;
        }
    };
    return {
        async get<T>(namespace: StoreNamespace, key: string): Promise<T | null> {
            await migrated();
            const value = await target.get<T>(namespace, key);
            if (value !== null || (await skipped(namespace, key))) return value;
            try {
                const left = await from.get<T>(namespace, key);
                if (left === null) return null;
                await moveOne(from, target, namespace, key);
                return (await target.get<T>(namespace, key)) ?? left;
            } catch (error) {
                options.logger?.warn("[cloud] a record could not be moved to the account id store", error);
                return null;
            }
        },
        put: async (namespace, key, value) => {
            await migrated();
            return target.put(namespace, key, value);
        },
        delete: async (namespace, key) => {
            await migrated();
            await target.delete(namespace, key);
            await from.delete(namespace, key).catch(() => undefined);
        },
        async keys(namespace) {
            await migrated();
            const keys = new Set(await target.keys(namespace));
            try {
                for (const key of await from.keys(namespace)) keys.add(key);
            } catch {
                // the old store can't be listed: the target's keys
            }
            return [...keys];
        },
    };
}

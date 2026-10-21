/**
 * A small least-recently-used map (Map insertion order); `onEvict` releases evicted values. Bounded by
 * entry count and, with `sizeOf`, by a byte budget (the newest entry is always kept, even alone over it).
 */
export interface LruCacheOptions<V> {
    maxBytes?: number;
    sizeOf?: (value: V) => number;
}

export class LruCache<V> {
    private readonly map = new Map<string, V>();
    private readonly sizes = new Map<string, number>();
    private total = 0;

    constructor(readonly max: number, private readonly onEvict?: (value: V, key: string) => void, private readonly options: LruCacheOptions<V> = {}) {}

    get size(): number {
        return this.map.size;
    }

    /** Bytes held (0 without `sizeOf`). */
    get bytes(): number {
        return this.total;
    }

    has(key: string): boolean {
        return this.map.has(key);
    }

    /** The value (now most recently used), or undefined. */
    get(key: string): V | undefined {
        const value = this.map.get(key);
        if (value === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    /** Value without refreshing its age. */
    peek(key: string): V | undefined {
        return this.map.get(key);
    }

    set(key: string, value: V): void {
        if (this.map.has(key)) this.forget(key);
        this.map.set(key, value);
        const bytes = this.options.sizeOf ? Math.max(0, this.options.sizeOf(value)) : 0;
        this.sizes.set(key, bytes);
        this.total += bytes;
        const maxBytes = this.options.maxBytes ?? Infinity;
        while (this.map.size > this.max || (this.total > maxBytes && this.map.size > 1)) {
            const oldest = this.map.keys().next().value as string;
            const evicted = this.map.get(oldest) as V;
            this.forget(oldest);
            this.onEvict?.(evicted, oldest);
        }
    }

    keys(): string[] {
        return [...this.map.keys()];
    }

    clear(): void {
        const entries = [...this.map.entries()];
        this.map.clear();
        this.sizes.clear();
        this.total = 0;
        for (const [key, value] of entries) this.onEvict?.(value, key);
    }

    private forget(key: string): void {
        this.total -= this.sizes.get(key) ?? 0;
        this.sizes.delete(key);
        this.map.delete(key);
    }
}

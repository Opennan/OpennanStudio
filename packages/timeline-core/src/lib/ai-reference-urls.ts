// Merge newly uploaded AI reference-image URLs into the existing list.
// Selecting several files at once must append ALL of them; doing this in one
// merged write (rather than one debounced updateClip per file off a stale
// render snapshot) is what prevents all-but-the-last upload from being dropped.

export function mergeAiReferenceUrls(existing: string[], uploaded: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const url of [...existing, ...uploaded]) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
    }
    return out;
}

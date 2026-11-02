// Private, device-local character/voice references shared by episodes and connected agents. No audio is uploaded.
import { parseSeriesCast, type SeriesCast } from "@opennan/story-film";
export const SERIES_LIBRARY_KEY = "opennan.series-cast.v1";
export const SERIES_LIBRARY_CHANGED = "opennan-series-cast-changed";
export function createSeriesLibrary(storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage) {
    const list = (): SeriesCast[] => {
        const raw = storage.getItem(SERIES_LIBRARY_KEY);
        if (!raw) return [];
        if (raw.length > 512_000) throw new Error("The saved series library is too large");
        const data: unknown = JSON.parse(raw);
        if (!Array.isArray(data) || data.length > 40) throw new Error("The saved series library could not be read");
        return data.map(parseSeriesCast);
    };
    return {
        list,
        save(value: unknown) {
            const cast = parseSeriesCast(value);
            const all = list().filter(s => s.id !== cast.id);
            if (all.length >= 40) throw new Error("The series library holds at most 40 series");
            storage.setItem(SERIES_LIBRARY_KEY, JSON.stringify([...all, cast]));
            if (typeof window !== "undefined") window.dispatchEvent(new Event(SERIES_LIBRARY_CHANGED));
        },
    };
}

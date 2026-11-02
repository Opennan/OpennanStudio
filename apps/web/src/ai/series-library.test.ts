import { createSeriesLibrary, SERIES_LIBRARY_KEY } from "./series-library";
const cast = { id: "rain", name: "Rain", characters: [{ id: "theo", name: "Theo", look: "ginger curls", voice: { providerId: "opennan", id: "vc_theo" } }] };
beforeEach(() => localStorage.clear());
it("reopens the same cast in a new episode/client and updates by stable id", () => {
    createSeriesLibrary().save(cast);
    const reopened = createSeriesLibrary();
    expect(reopened.list()).toEqual([cast]);
    reopened.save({ ...cast, name: "Rain check" });
    expect(createSeriesLibrary().list()).toEqual([{ ...cast, name: "Rain check" }]);
});
it("does not silently overwrite corrupt storage on save", () => {
    localStorage.setItem(SERIES_LIBRARY_KEY, "broken");
    expect(() => createSeriesLibrary().save(cast)).toThrow();
    expect(localStorage.getItem(SERIES_LIBRARY_KEY)).toBe("broken");
});

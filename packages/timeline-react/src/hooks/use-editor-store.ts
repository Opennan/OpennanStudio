import { useContext } from "react";
import { useStore } from "zustand";
import type { EditorState, EditorStore } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import { getActiveEditorStore } from "../provider/registry";

export { useShallow } from "zustand/react/shallow";

export function useEditorStoreApi(): EditorStore {
    return useContext(TimelineContext)?.store ?? getActiveEditorStore();
}

export function useEditorStore<T>(selector: (state: EditorState) => T): T {
    return useStore(useEditorStoreApi(), selector);
}

# Timeline Invariants — READ BEFORE CHANGING TIMELINE CODE

Every rule below exists because its violation shipped as a user-visible bug
(2026-07-03/04 timeline rework). If a change breaks one of these, it will
resurface the same bug. Each rule names the enforcing code.

## 1. One source of truth for positions
`timeline_position_seconds` is THE scene position. Layout never derives
positions from `order`; `order` is display numbering only, kept sorted by
position server-side.
- Enforced: `canvas/scene-position.ts` (`getSceneTimelineStart`), backend
  `_scene_transition_start_map`.
- **Sentinel caveat:** a stored position of exactly `0` means "unpositioned
  legacy row" and falls back to cursor placement. Therefore all writes clamp
  to `>= 0.001` (`engine/persist.ts`, position mutations in
  `nle-timeline.tsx`). Writing a literal 0 makes the scene's layout depend on
  stale array order → the strip visibly collapses for a round-trip.

## 2. Preview === commit
A drag's on-screen preview and its persisted result MUST come from the same
`resolveMove` call with the same arguments (including `targetTrackId` +
`primaryId`). Two code paths = the drop landing somewhere else than shown.
- Enforced: `canvas-timeline.tsx` `buildState` (preview) and
  `getSceneDragChanges` (commit) both call `engine/move.ts:resolveMove`.
- The neighbor-easing lerp (`sceneDragPreviewLerpRef`) smooths ONLY the
  preview drawing; the committed values are the raw engine result.

## 3. Drag semantics (engine/move.ts)
- Free placement; gaps allowed.
- Rightward overlap pushes later items right by exactly the overlap.
- Leftward drags clamp at the previous item's end…
- …UNLESS the dragged block's START passes a neighbor's MIDPOINT — that is
  the user's reorder intent: the neighbor hops to the other side, shifted by
  the block's duration (swap / insert-between). Midpoint = the intent
  boundary separating "slide" from "reorder"; do not change it to
  start-edge or center-vs-center without re-testing both intents.
- `targetTrackId` applies ONLY to the primary (grabbed) scene.

## 4. Resize rules
- Content-backed scenes are capped at their MEASURED media length; the
  measured value OVERRIDES shot-sum bounds (never `min()` them — shot sums
  get rewritten by retimes and a shrink would poison the cap forever, see
  `canvas-timeline.tsx` resize mousedown + `getSceneContentDuration`).
- Growth is gap-aware: free space absorbs it; neighbors move only by real
  overlap (engine sweep in `handleUpdateSceneDuration`). Shrink keeps the
  close-the-gap ripple.
- Edge-resize engages ONLY on an already-selected scene (first click
  selects, then the handles are live) — otherwise fast flicks that grab
  within 6px of an edge stretch the scene instead of moving it.
- Clips narrower than `RESIZE_ZONE * 3` have NO inner handles; when selected
  they expose OUTER handles instead (hit-detector + `drawClipTrimHandles`).
  The outer zones are checked AFTER body hit-testing so they can never steal
  a click from a neighboring scene.

## 5. Selection rules
- Scene ends carry float noise (`7.360000000000001`); seeks land on rounded
  starts (`7.36`). Any "which scene contains time T" lookup MUST use a
  boundary epsilon (`scene-preview.tsx` `getActiveSceneFromRanges`,
  BOUNDARY_EPS) or selecting a scene snaps back to its predecessor.
- A selected marker owns Delete/Backspace. There are TWO window keydown
  handlers (editor-layout + canvas); each must return early on
  `e.defaultPrevented` or one keypress deletes a marker AND a scene.

## 6. Optimistic-first editing
Server round-trips can take seconds (and 10-30s on dev machines far from the
DB). Every edit must reflect instantly and reconcile later:
- Deletes hide via `deletedSceneIds` immediately; restore on failure.
- Position saves retry ONCE on timeout with a fresh AbortController; the
  abort-vs-timeout race is disambiguated by the `saveTimedOut` flag — do not
  catch by error name alone (`nle-timeline.tsx` batch save).
- Successful batch saves apply the mutation's returned scenes to the local
  cache (`patchReturnedTimelineScenes`) — never wait for a poll to show the
  user their own edit.
- The "Syncing edit" badge = `activeTimelineSaves > 0` (real in-flight
  fetches, counted in `postTimelineGraphql`). Do NOT key it off unconfirmed
  overrides; overrides only clear when a poll echoes them, so the spinner
  never stopped.
- Resizes apply optimistically BEFORE any await (`handleUpdateSceneDuration`):
  even the token fetch costs 1.5s+. Generative scenes derive strip width from
  the SHOT SUM, so the optimistic patch must also retime the shots locally
  (same proportional rule as the backend) — patching `duration` alone changes
  nothing on screen. shotBreakdown overrides converge by comparing TOTAL
  duration, not string equality (`localFieldMatchesServer`).
- PROP-WIRING TRAP: optimistic callbacks (`onLocalScenePatch`,
  `onSceneOverridesUpdate`, `onOptimisticSceneDelete`) are optional props.
  If one isn't passed to `<NleTimeline>` in editor-layout.tsx, every
  optimistic apply is a SILENT no-op and edits lag by full round-trips —
  `onLocalScenePatch` was wired to ChatTab but not the timeline for a while.
  When adding an optimistic path, verify the prop reaches the component.

## 7. Zoom/viewport rules (engine/viewport.ts)
- All zoom entry points (wheel, buttons, fit, fit-selection) compose through
  `zoomTo`/`zoomAt`, reading CURRENT state — never a value captured at
  mount, and never a lossy `current * (target/current)` round-trip (float
  drift poisoned the zoom-level table lookup and froze zoom).
- One ceiling: `MAX_PX_PER_SECOND` — every path clamps with it.
- Auto-fit runs on open and hands off FOREVER after the first manual zoom
  (`userZoomedRef` in `nle-timeline.tsx`). Auto-fit that keeps re-applying
  reads as "my zoom snaps back".

## 8. Popup positioning
Anything positioned near the cursor/button must either render in a body
portal (`add-track-button.tsx`) or clamp with a REAL size estimate
(`canvas-context-menu.tsx: getContextMenuEstimatedHeight` — an unknown hit
type falling through to 720px pinned a 1-item menu to the screen top; add an
entry for every new context-menu hit type).

## 9. Empty scenes must be visible
Scenes with no media render with hatch + "empty scene" label
(`timeline-renderer.ts drawSceneClip`). An invisible strip still blocks
drags and reads as a haunted timeline.

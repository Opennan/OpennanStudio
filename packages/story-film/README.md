# @opennan/story-film

Story film for OpenNan Studio: a consistent-character animated short (any art style, any story, ~12 shots, ~60 s)
in a 9:16 reel frame, made from a written story or from a copied video's beats.

- `parseStoryFilm(value)`: the story film (title, style, medium, characters, shots, music, the assets made so far)
  checked and normalized; shot seconds 4 to 15 (default 5). See `examples/story-film/rain-check.json`.
- `sheetPrompt`, `keyframePrompt`, `motionPrompt`, `musicPrompt` (`recipe.ts`): the proven recipe's prompts.
- `writeDraftRequest`, `copyDraftRequest`, `parseDraftReply`: drafts from a `text.generate` provider. A copy makes an
  original cast and a new title by default (`cast: "keep"` only for the person's own video).
- `estimateStep`, `runStep` over a `StoryFilmHost` (run + price one provider capability): steps `cast`
  (`image.generate`), `frames` (`image.generate` with the cast's sheets and the previous keyframe as references),
  `animate` (`video.image-to-video`, the keyframe as the first frame), `music` (`audio.music`). Every result is stored
  on the story with the request that made it, so a re-run never pays twice; `redo` makes one item again.
- The cast check (`check.ts`, frames step): after each keyframe one `text.generate` call with images looks at it beside
  the cast's sheets and answers strict JSON per character (hair, outfit, colours). A miss redraws the keyframe with the
  look restated (`castCheck`: redraws, default 1, 0 turns it off); a shot still off is kept and flagged on the story
  (`shot.check`, `isFlagged`). `estimateStep` counts every check and every possible redraw.
- `reelInputOf(story)`: the input of timeline-core's `applyReelLayout` (9:16, the title above the 16:9 film, music).

The skill for agents is `skills/story-film/SKILL.md`.

---
name: story-film
description: Make a story film in OpenNan Studio - a ~60 s animated short with the same characters in every shot (any art style), laid out as a 9:16 reel with the title above a 16:9 film - from a written story or by copying the beats of a reference video. Use when someone asks for an animated short, a "story" reel, a hand-drawn/3D/anime short with consistent characters, or to remake/copy a video's story.
---

# Story film

A story film is ~12 shots of the same characters, each shot drawn as one keyframe from character design sheets and
then animated, in a 9:16 reel: black frame, short title above a 16:9 film, one music bed. It works for any art style
and any story. Everything below runs through OpenNan Studio's MCP tools (`opennan-studio mcp serve`, or the desktop
app's built-in server). The story is stored on the project, so agents and the editor share it.

## In the editor

- **AI library → Story film** (the wide tile under the generate tiles) opens the Story film window. There is no
  director chat: the window is the whole flow.
- Six steps: Story (write, or copy a video) → Cast → Shots → Animate → Music → Timeline. Back, Next and Close sit at
  the bottom.
- Every paid button shows its price first, asks you to sign in first, and checks the balance covers the run. Cancel
  stops a step; closing the window cancels what runs. What was made stays on the story and is never paid for twice.
- Shots has **Check characters match (+~$x per shot)**, on by default (see the cast check below). A flagged shot is
  ringed and says **Check this shot** with what differs.

## The recipe (what makes the characters stay the same)

1. **Story** (`story.json`, see `examples/story-film/rain-check.json`): `title`, `style`, `medium` (`2d` | `3d` |
   `stop-motion` | `anime`), `characters` `[{ id, name, look }]`, `shots` `[{ id, cast, frame, motion, seconds }]`,
   `music`. 5 s a shot (4 to 15).
   - `style` is one paragraph that ends every image prompt: medium, linework, shading, palette, light, era, and
     "cinematic 16:9 composition, no text, no watermark".
   - `look` lists what never changes: build, face, hair, clothes, colours. It is restated in every keyframe prompt
     next to "exactly as drawn in reference image i" - skipping it once gave a character another hairstyle.
   - `frame` is one still: shot size, place, light, who is where doing what. `motion` is only what moves from that
     still, and the camera. **The motion must match the frame** (never "she walks in" when she is already in frame).
   - Two characters in one shot are fine: list both in `cast`, most important first.
2. **Cast sheets** (`story_film_cast`): one 16:9 2K model sheet per character (turnaround + four expressions, plain
   off-white background), no references. **Look at every sheet** before going on; redo a bad one
   (`ids: ["mae"], redo: true`). Every keyframe is drawn from these.
3. **Keyframes** (`story_film_frames`): one 16:9 2K image per shot, in order, references = the shot's cast sheets (in
   cast order) + the previous shot's keyframe (the style anchor). The cast check runs after each one (below).
   **Review every keyframe**, flagged ones first (they are project images: `story_film_get` lists their URLs;
   `preview_timeline_frame` or the editor shows them). Fix the text and redo one with `ids` + `redo`; redoing a
   keyframe marks the next shot's keyframe and its own clip as "changed".
4. **Animate** (`story_film_animate`): image-to-video from each keyframe, 5 s, 16:9, 720p, no sound.
   Default model `seedance-2-5` (rigid objects, believable physics, stable characters; about $3.07 per 5 s at 720p).
   When the provider does not list it, `seedance-2-mini` (about $0.26 per 5 s; cheap, but objects can morph and
   physics can break). Use only models the provider lists.
   **Watch every clip before the reel**: hands keep holding what they hold, objects stay one shape, rain and cloth fall
   the right way, each action makes sense. Redo a clip that fails (`ids` + `redo`), with the action written more
   plainly in its motion text. Clips run two at a
   time; a call may stop at the 10-minute tool limit - call it again, finished clips are skipped.
5. **Music** (`story_film_music`): one instrumental bed the length of the film.
6. **Reel** (`story_film_assemble`): 1080x1920 black canvas, the film 1080x608 at y = 656 (centred), the title bold
   white 46 px with its baseline 34 px above the film, the music faded in 0.5 s and out 2.5 s. Placing it again
   replaces the earlier placement. `apply_reel_layout` does the same layout for any clips.

## The cast check (frames step)

- After each keyframe, one cheap look (the story writer's text model, with images) compares it with the sheets of the
  shot's cast: same hair, outfit and colours, yes or no per character, and why.
- A character off their sheet: the keyframe is redrawn once with that look restated first in the prompt, then looked
  at again. Still off after that: the frame is kept and the shot is flagged ("check this shot"); look at it and redo it.
- An answer that does not read never pays for a redraw; the shot is flagged for you to look at.
- Cost: each look is priced like the other text calls (the window shows "+~$x per shot"). The step's price counts every
  look and, worst case, one redraw per shot at its image price, so the Shots price is never under what a run costs
  (usually it costs less).
- The verdict is stored on the shot with its keyframe: a re-run never pays for it again; a redone keyframe is looked at
  again.
- Turn it off: untick the box on Shots, or `story_film_frames { cast_check: 0 }`. `cast_check: 2` or `3` allows more
  redraws (each one counted in the price).
- `story_film_frames` answers `redrawn` and `flagged` (shot ids with what differs); `story_film_get` progress lists
  `flagged` for frames.

## Tool order

```
story_film_create { story }            # or { text: "the story in your words" } to have the story writer draft it
  or story_film_copy { media_url | video_url | sheet_image_url }
story_film_get                         # read the draft back, fix it, story_film_create { story } again (files of kept ids stay)
story_film_cast    { estimate_only: true }  -> then without it (accept_max_usd: the price you agreed)
story_film_frames  { estimate_only: true }  -> review each keyframe (flagged first), redo bad ones with ids + redo
story_film_animate { estimate_only: true, model?, quality? }
story_film_music
story_film_assemble
```

Every paid tool answers its price with `estimate_only: true` and runs nothing; pass `accept_max_usd` so a higher
estimate stops before anything is sent. A re-run makes only what is missing and never pays twice. Tell the person the
total before animating: a 12-shot film is under $1 for sheets and keyframes (the cast check adds a small look per
shot) and about $37 of clips at `seedance-2-5` 720p (about $3 at `seedance-2-mini`).

## Copying a video safely

- `story_film_copy` samples 16 frames of the video onto one contact sheet and the story writer retells it: same beats,
  order, pacing and feel. **By default the cast and title are original** (new character designs, names and title):
  safe to publish. Use `cast: "keep"` only when the video is the person's own.
- `video_url` takes video-site links (Instagram, TikTok, YouTube...), downloaded into the project for free.
  `media_url` takes a project video. Sampling needs the editor or `mcp serve --ffmpeg`; elsewhere (the desktop app's
  built-in server too) make the sheet yourself and pass `sheet_image_url`:
  `ffmpeg -i video.mp4 -vf "fps=16/DURATION,scale=480:-2,tile=4x4" -frames:v 1 sheet.jpg`.
- The draft is a draft: read it, fix names, looks and motions, and save it before drawing anything.

## Checks before you call it done

- Every sheet and keyframe looked at; the same face, hair and clothes in every shot; no shot left flagged.
- Every motion matches its keyframe.
- `story_film_get` shows nothing missing and nothing "changed since made" you did not mean to keep.
- After `story_film_assemble`, look at a frame (`preview_timeline_frame`) and export (`assemble_video`).

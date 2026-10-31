---
name: story-film
description: Make a story film in OpenNan Studio - a ~60 s animated short with the same characters in every shot (any art style), laid out as a 9:16 reel with the title above a 16:9 film - from a written story or by copying a reference video closely (shot by shot, the same framing). Use when someone asks for an animated short, a "story" reel, a hand-drawn/3D/anime short with consistent characters, or to remake/copy a video's story.
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
- Copy a video makes a close copy (see "Copy and remake a video" below): the title (default: the video's), an art
  style, the characters (kept, or new), **Keep the original motion (remake each shot)** (on by default when the video
  model takes reference videos), and the required "I own this video or have the rights to remake it". Animate then says
  each shot is remade from its original shot, shows that shot under each clip, and its price counts the reference
  seconds.

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
   A story copied with "keep the original motion" is **remade** instead, shot by shot, from the video's real shots
   (below): the motion is the real shot's, so its physics hold by construction.
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

## Copy and remake a video

`story_film_copy` (editor: Story → Copy a video) makes a **close copy** by default: the same story, the same shots in
the same order, the same framing, drawn in the art style the person picks.

1. **Shots**: Studio finds the video's cuts (a frame that stands out from the second around it, so a faint cut in a
   flickering old film counts and a steady pan does not) and makes shots of 2 to 15 s (a piece under 2 s joins its
   shorter neighbour, a piece over 15 s is split evenly; at most 40 shots). Each shot's first frame is saved as a
   project image (`story-shot-01.jpg`) and, with keep motion, the shot is cut out as a project video
   (`story-shot-01.mp4`). Each story shot keeps `source: { start, end, frame, clip }`.
2. **The draft**: a few frames of every shot on one contact sheet (labelled S1, S2, ...). The story writer writes exactly
   one story shot per real shot, in order, and never invents, merges, reorders or drops a beat. Each shot's frame and
   motion text say what that shot shows: who, where, the framing (wide / medium / close), the camera move, the action.
   The video's characters keep their roles and looks (drawn in the chosen style) and its title is kept unless the
   person types another (`title`); `style` is the person's art style. `cast: "original"` makes new characters and a new
   title instead.
3. **Keyframes** copy the original framing: each one is an image edit of the shot's own first frame (reference image 1)
   with the cast's sheets and the previous keyframe: "Redraw reference image 1 exactly: the same composition, camera
   angle, framing, poses ... as ..., with these characters".
4. **Animate** with keep motion (`keep_motion`, on by default when the video model takes reference videos) remakes each
   shot from the real one. The shot's clip is the reference video `@Video1`; the cast's sheets then the shot's keyframe
   are `@Image1..n` (9 at most).
   - A shot of at least the model's edit minimum (4 s on `seedance-2-5`) is **edited** (`reference_mode: "editing"`):
     "Turn @Video1 into ...; the people become Theo (@Image1) ...; keep every movement, the timing, the framing and the
     camera exactly". The clip keeps the source's framing and is as long as the shot.
   - A shorter shot copies the motion (`reference`), starting exactly like its keyframe. Its length is the model's
     length nearest the real shot's; on the reel each shot runs as long as its real shot.
5. **Review each clip beside its original shot** (the Animate step shows both; `story_film_get` lists the clips and each
   shot's `source`): the same action, framing and camera, the cast on model. Fix the text and redo a clip with `ids` +
   `redo`.

- **Limits** (the model publishes them; Studio checks them before anything is uploaded and says what is wrong): each
  reference 2-30 s and 30 s in all, MP4 or MOV, sides 300-6000 px, at least 409,600 pixels a frame (a smaller video is
  scaled up, for example 640x360 to 854x480), 24-60 fps. A real shot out of the limits is blocked with the reason; a
  prepared clip longer than the length it was priced at is never sent.
- **Cost**: the reference seconds are billed with the output seconds; an edit is billed as long as its video (output
  seconds = reference seconds). With `seedance-2-5` at 720p a 5 s shot is about $3.69 either way (about $3.07 from a
  keyframe); a 7 s edit about $5.17. The estimate counts each clip's length with a small margin, rounded up to whole
  seconds, so it is never under what the run costs.
- **Other models**: a model that takes no reference videos (such as `seedance-2-mini`) animates from the keyframes, as
  does `keep_motion: false` (on `story_film_copy` or `story_film_animate`). The shots keep their place in the video.
- **Hosts**: the editor finds shots and cuts clips in the page, and `mcp serve --ffmpeg` with ffmpeg. The desktop app's
  built-in MCP server cannot sample frames or find shots yet: make the sheet yourself, pass `sheet_image_url`, `media_url`
  (the project video) and `shots: [{ start, end }]`: list every frame's scene score (`ffmpeg -i video.mp4 -vf
  "select='gte(scene,0)',metadata=print" -f null -`), cut where a frame's score is the largest within 1 s around it, at
  least 0.12 and 5 times the median score of that second (a fixed threshold misses faint cuts), then make 2-15 s pieces.
  Each shot's keyframe frame and its clip are then taken from the project video when they are drawn and animated.

## Tool order

```
story_film_create { story }            # or { text: "the story in your words" } to have the story writer draft it
  or story_film_copy { media_url | video_url | sheet_image_url, rights_confirmed: true, title?, style?, cast?, keep_motion? }
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

## Copying a video: rights

- A copy is close to the source on purpose, so **the person is responsible for having the rights to the video**. The
  editor's Copy button stays off until they tick "I own this video or have the rights to remake it";
  `story_film_copy` refuses without `rights_confirmed: true`. Pass it only when the person says so; never assume it.
- `cast: "original"` (new characters and a new title in the same roles) moves the copy further from the source; it
  does not replace having the rights.
- `video_url` takes video-site links (Instagram, TikTok, YouTube...), downloaded into the project for free.
  `media_url` takes a project video. Shots and frames need the editor or `mcp serve --ffmpeg`; elsewhere (the desktop
  app's built-in server too) make the sheet yourself and pass `sheet_image_url` (see Hosts above):
  `ffmpeg -i video.mp4 -vf "fps=16/DURATION,scale=480:-2,tile=4x4" -frames:v 1 sheet.jpg`.
- The draft is a draft: read it, fix names, looks and motions, and save it before drawing anything.

## Checks before you call it done

- Every sheet and keyframe looked at; the same face, hair and clothes in every shot; no shot left flagged.
- Every motion matches its keyframe; a remade clip matches its original shot's action and camera.
- `story_film_get` shows nothing missing and nothing "changed since made" you did not mean to keep.
- After `story_film_assemble`, look at a frame (`preview_timeline_frame`) and export (`assemble_video`).

# Series cast and dialogue

Story Film → Voices saves a series cast on this device and character voice references on each project. The same library is exposed through Studio's MCP server, so Claude Code and Codex use the same character IDs, descriptions and voices when continuing a series. It does not publish recordings, transfer clone ownership, or sync the device library to another computer.

Create an owned voice at https://opennan.com/products/voice/clone using the existing sample and recorded-consent flow. Sign into that account in Studio, refresh voices, and assign the clone to a character. The authenticated voice list is refreshed without retaining another account's clone list. Unavailable voices stay visibly unavailable; dubbing refuses rather than choosing a replacement.

For each shot, choose dialogue with a named speaker and start/end times, explicit silence, or leave it unassigned. Unassigned is not silence. An off-screen speaker is allowed; other visible characters listen. Lines are sequential and must fit the shot. The animation prompt carries this speaking schedule, but generated mouth movements still need review; this is not automatic speaker recognition or a lip-sync guarantee.

For an agent workflow:

1. Call `series_cast_list` before planning a continuing episode.
2. Create the episode using the saved character IDs, then call `series_cast_apply`.
3. Use `story_film_set_dialogue` for every shot. `[]` explicitly means silence.
4. Call `story_film_dub` with `estimate_only: true`, then pass an accepted `accept_max_usd` for paid generation.
5. Assemble the story, then dub to place takes into the correct shot. Existing takes are reused without generation charges. A take longer than its assigned interval is saved for review and is never silently truncated.

Changing speaker, words or voice invalidates the old take. Changing timing keeps the cached audio but removes its old placement. Marking a shot silent removes the generated dialogue linked to it. Edited or locked clips require review instead of automatic removal. Reassembling replaces old dialogue placements; running dubbing again reuses the saved audio. Cancelled/failed runs retain completed takes for retry.

The local UI test covers typing, invalid timing, save, reopen and a second episode. MCP tests exercise the real server/controller with fixture speech output and prices. No real user audio or paid speech generation was used for these checks.

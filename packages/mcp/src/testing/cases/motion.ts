// Round-trip cases for text templates and styles, animations, stickers, keyframes, speed, and caption styles
// (phase 10b): each checks the state change through the controller and that undo_last_edit reverts the call.
import { clipOf, data, scenesOf, type Case } from "../roundtrip";
import type { FixtureStudio } from "../fixture";

const style = (studio: FixtureStudio, id: string) => JSON.parse(clipOf(studio, id)?.textStyle || "{}");
const json = (value: string | null | undefined) => (value ? JSON.parse(value) : null);
const tracksOf = (studio: FixtureStudio, type: string) => studio.controller.snapshot().tracks.filter((t) => t.type === type).map((t) => t.index).sort();
const lockTrack = async (studio: FixtureStudio, type: string, index: number) => {
    const tracks = studio.controller.snapshot().tracks.map((t) => (t.type === type && t.index === index ? { ...t, locked: true } : t));
    await studio.controller.execute({ type: "track.update", tracks });
};

export const MOTION_CASES: Record<string, Case> = {
    list_text_templates: async (call) => {
        const all = data(await call("list_text_templates"));
        expect(all.templates).toHaveLength(20);
        expect(all.templates[0]).toMatchObject({
            id: "plain", name: "Plain", category: "basic", default_text: "Add your text", font_family: "Inter", animation: { in: { id: "fade", duration: 0.4 } },
        });
        expect(all.fonts).toHaveLength(12);
        expect(all.fonts[0]).toEqual({ family: "Inter", weights: [400, 700, 900], category: "sans" });
        expect(all.caption_styles).toHaveLength(8);
        expect(all.caption_styles.find((s: { id: string }) => s.id === "karaoke_box")).toMatchObject({ karaoke: true });
        const neon = data(await call("list_text_templates", { category: "neon" }));
        expect(neon.templates.map((t: { id: string }) => t.id)).toEqual(["neon_pink", "neon_cyan", "soft_glow"]);
    },
    apply_text_template: async (call, studio) => {
        // On an existing text clip: the template's style and animation.
        expect(data(await call("apply_text_template", { clip_id: "title", template_id: "neon_pink" }))).toMatchObject({ ok: true, clipId: "title", templateId: "neon_pink" });
        expect(style(studio, "title")).toMatchObject({ glowColor: "#FF2BD6", fontSize: 84 });
        expect(json(clipOf(studio, "title")?.animationJson)).toMatchObject({ loop: { id: "glow" } });
        expect(clipOf(studio, "title")?.textContent).toBe("Hello");
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "title")?.textStyle ?? null).toBeNull();

        // A new clip: T1 is busy at 1-3 s, so it lands on a new text track 2, made in the same call.
        const created = data(await call("apply_text_template", { template_id: "title_bold", text: "Big news", start_time: 1, end_time: 3 }));
        expect(created).toMatchObject({ ok: true, trackIndex: 2 });
        const clip = clipOf(studio, created.clipId)!;
        expect(clip).toMatchObject({ trackType: "text", trackIndex: 2, startTime: 1, endTime: 3, textContent: "Big news", positionX: 0.5, positionY: 0.5 });
        expect(JSON.parse(clip.textStyle!)).toMatchObject({ fontWeight: "900", fontSize: 96 });
        expect(json(clip.animationJson)).toEqual({ in: { id: "pop", duration: 0.5 } });
        expect(tracksOf(studio, "text")).toEqual([1, 2]);
        // One undo removes the clip and the new track.
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, created.clipId)).toBeUndefined();
        expect(tracksOf(studio, "text")).toEqual([1]);

        // The template's sample text when none is given; a free track is reused.
        const sample = data(await call("apply_text_template", { template_id: "lower_third", start_time: 5, end_time: 7, position_y: 0.82 }));
        expect(clipOf(studio, sample.clipId)).toMatchObject({ trackIndex: 1, textContent: "Alex Morgan · Creator", positionY: 0.82 });

        expect(data(await call("apply_text_template", { template_id: "plain" })).error).toMatch(/clip_id, or text with start_time and end_time/);
        expect(data(await call("apply_text_template", { template_id: "plain", clip_id: "music" })).error).toMatch(/not a text clip/);
        expect(data(await call("apply_text_template", { template_id: "plain", start_time: 3, end_time: 2 })).error).toMatch(/end_time must be after start_time/);
    },
    set_text_style: async (call, studio) => {
        const set = data(await call("set_text_style", {
            clip_id: "title", font_family: "Bebas Neue", font_size: 80, font_weight: 700, color: "#ffee00", background_color: "#000000",
            background_padding: 12, gradient_from: "#ff0000", gradient_to: "#0000ff", line_height: 1.1, text_align: "left",
        }));
        expect(set).toMatchObject({ ok: true, clipId: "title" });
        expect(style(studio, "title")).toEqual({
            fontFamily: '"Bebas Neue", Impact, "Arial Narrow", sans-serif', fontSize: 80, fontWeight: "700", color: "#ffee00", bgColor: "#000000",
            bgPadding: 12, gradient: { from: "#ff0000", to: "#0000ff", angle: 90 }, lineHeight: 1.1, textAlign: "left",
        });
        // An angle alone keeps the colors; null resets a field and removes the gradient.
        await call("set_text_style", { clip_id: "title", gradient_angle: 45 });
        expect(style(studio, "title").gradient).toEqual({ from: "#ff0000", to: "#0000ff", angle: 45 });
        await call("set_text_style", { clip_id: "title", font_size: null, gradient_from: null });
        expect(style(studio, "title").fontSize).toBeUndefined();
        expect(style(studio, "title").gradient).toBeUndefined();
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(style(studio, "title")).toMatchObject({ fontSize: 80, gradient: { angle: 45 } });

        expect(data(await call("set_text_style", { clip_id: "title" })).error).toMatch(/at least one style field/);
        expect(data(await call("set_text_style", { clip_id: "music", color: "#fff" })).error).toMatch(/not a text clip/);
        await call("set_text_style", { clip_id: "title", gradient_from: null });
        expect(data(await call("set_text_style", { clip_id: "title", gradient_from: "#fff" })).error).toMatch(/gradient_from and gradient_to/);
        // Colours: hex, numeric rgb()/rgba()/hsl()/hsla(), and basic names pass; anything else is refused (a bad
        // gradient colour made the canvas throw in the preview and the export).
        const colors = { color: "rgba(0, 0, 0, 0.5)", stroke_color: "#ff000080", shadow_color: "hsl(200 50% 40% / 0.5)", glow_color: "Gold", background_color: "transparent", gradient_from: "#abc", gradient_to: "hsla(10, 20%, 30%, 1)" };
        expect(data(await call("set_text_style", { clip_id: "title", ...colors }))).toMatchObject({ ok: true });
        expect(style(studio, "title")).toMatchObject({ color: "rgba(0, 0, 0, 0.5)", strokeColor: "#ff000080", glowColor: "Gold", gradient: { from: "#abc", to: "hsla(10, 20%, 30%, 1)" } });
        for (const [arg, value] of [
            ["color", "not-a-colour"], ["stroke_color", "#12"], ["shadow_color", "rgb(a, b, c)"], ["glow_color", "url(x)"],
            ["background_color", "var(--x)"], ["gradient_to", "#ggg"], ["gradient_from", "rgb(1,2,3); color: red"],
        ] as const) {
            expect(data(await call("set_text_style", { clip_id: "title", [arg]: value })).error, arg).toMatch(new RegExp(`${arg} must be a CSS color`));
        }
        expect(data(await call("set_text_style", { clip_id: "title", gradient_from: "#fff", gradient_to: "nope" })).error).toMatch(/gradient_to must be a CSS color/);
        // Sizes are capped (schema and handler).
        expect((await call("set_text_style", { clip_id: "title", font_size: 401 })).isError).toBe(true);
        expect((await call("set_text_style", { clip_id: "title", letter_spacing: 5000 })).isError).toBe(true);
        await lockTrack(studio, "text", 1);
        expect(data(await call("set_text_style", { clip_id: "title", color: "#fff" })).error).toMatch(/locked track text1/);
    },
    list_animations: async (call) => {
        const clipIn = data(await call("list_animations", { kind: "clip", slot: "in" }));
        expect(clipIn.animations.map((a: { id: string }) => a.id)).toContain("fade_in");
        expect(clipIn.animations[0]).toMatchObject({ slot: "in", default_duration: expect.any(Number), name: expect.any(String) });
        const text = data(await call("list_animations", { kind: "text" }));
        expect(new Set(text.animations.map((a: { slot: string }) => a.slot))).toEqual(new Set(["in", "out", "loop"]));
        const stickerLoops = data(await call("list_animations", { kind: "sticker", slot: "loop" })).animations.map((a: { id: string }) => a.id);
        expect(stickerLoops).toContain("pulse");
        expect(stickerLoops).not.toContain("glow");
    },
    set_animation: async (call, studio) => {
        expect(data(await call("set_animation", { scene_order: 1, slot: "in", animation_id: "fade_in", duration: 0.6 }))).toMatchObject({ ok: true, animation: { in: { id: "fade_in", duration: 0.6 } } });
        expect(json(scenesOf(studio)[0].animationJson)).toEqual({ in: { id: "fade_in", duration: 0.6 } });
        // A combo replaces in and out.
        await call("set_animation", { scene_order: 1, slot: "combo", animation_id: "combo_zoom_pulse" });
        expect(json(scenesOf(studio)[0].animationJson)).toEqual({ combo: { id: "combo_zoom_pulse" } });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(json(scenesOf(studio)[0].animationJson)).toEqual({ in: { id: "fade_in", duration: 0.6 } });
        // Text loops; "none" removes the slot.
        await call("set_animation", { clip_id: "title", slot: "loop", animation_id: "pulse" });
        expect(json(clipOf(studio, "title")?.animationJson)).toEqual({ loop: { id: "pulse", period: 1 } });
        await call("set_animation", { clip_id: "title", slot: "loop", animation_id: "none" });
        expect(clipOf(studio, "title")?.animationJson ?? null).toBeNull();

        expect(data(await call("set_animation", { clip_id: "title", slot: "combo", animation_id: "combo_swing" })).error).toMatch(/text uses loop animations/);
        expect(data(await call("set_animation", { clip_id: "title", slot: "in", animation_id: "nope" })).error).toMatch(/unknown in animation/);
        expect(data(await call("set_animation", { clip_id: "music", slot: "in", animation_id: "fade_in" })).error).toMatch(/audio clip/);
        expect(data(await call("set_animation", { slot: "in", animation_id: "fade_in" })).error).toMatch(/needs clip_id or scene_order/);
        // Graphics clips take clip animations.
        const graphics = data(await call("add_graphics_clip", { template_id: "lower-third", start_time: 4, end_time: 8 })).clipId;
        expect(data(await call("set_animation", { clip_id: graphics, slot: "in", animation_id: "fade_in" }))).toMatchObject({ ok: true, clipId: graphics });
        expect(json(clipOf(studio, graphics)?.animationJson)).toMatchObject({ in: { id: "fade_in" } });
    },
    list_stickers: async (call) => {
        const all = data(await call("list_stickers", { limit: 200 }));
        expect(all.total).toBe(96);
        expect(all.stickers).toHaveLength(96);
        expect(all.categories).toHaveLength(11);
        const hearts = data(await call("list_stickers", { query: "heart" }));
        expect(hearts.stickers.map((s: { id: string }) => s.id)).toContain("twemoji:1f60d");
        expect(hearts.stickers.find((s: { id: string }) => s.id === "twemoji:1f60d")).toEqual({ id: "twemoji:1f60d", name: "Heart eyes", category: "emoji-faces", emoji: "😍" });
        const arrows = data(await call("list_stickers", { category: "arrows", limit: 2 }));
        expect(arrows.stickers).toHaveLength(2);
        expect(arrows.total).toBeGreaterThan(2);
        expect(arrows.stickers.every((s: { category: string }) => s.category === "arrows")).toBe(true);
    },
    add_sticker: async (call, studio) => {
        // No sticker track yet: the call adds sticker track 1 and the clip.
        const first = data(await call("add_sticker", { sticker_id: "opennan:arrow-right", start_time: 1, end_time: 3, position_x: 0.25, scale: 0.5 }));
        expect(first).toMatchObject({ ok: true, trackIndex: 1 });
        expect(clipOf(studio, first.clipId)).toMatchObject({
            trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3, stickerId: "opennan:arrow-right", mediaType: "sticker", label: "Arrow",
            positionX: 0.25, positionY: 0.5, scale: 0.5,
        });
        expect(tracksOf(studio, "sticker")).toEqual([1]);
        // Overlapping: a second sticker track; one undo takes the clip and that track back.
        const second = data(await call("add_sticker", { sticker_id: "twemoji:1f60d", start_time: 2, end_time: 4 }));
        expect(clipOf(studio, second.clipId)).toMatchObject({ trackIndex: 2, stickerId: "twemoji:1f60d" });
        expect(tracksOf(studio, "sticker")).toEqual([1, 2]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, second.clipId)).toBeUndefined();
        expect(tracksOf(studio, "sticker")).toEqual([1]);
        expect(clipOf(studio, first.clipId)).toBeDefined();

        expect(data(await call("add_sticker", { sticker_id: "nope", start_time: 0, end_time: 1 })).error).toMatch(/Unknown sticker nope/);
        expect(data(await call("add_sticker", { sticker_id: "opennan:arrow-right", start_time: 2, end_time: 3, track_index: 1 })).error).toMatch(/sticker1 already has/);
    },
    set_keyframe: async (call, studio) => {
        await call("set_keyframe", { scene_order: 1, time: 0, values: { scale: 1 } });
        const set = data(await call("set_keyframe", { scene_order: 1, time: 2, values: { scale: 1.5, position_x: 10 }, easing: "ease_out" }));
        expect(set).toMatchObject({ ok: true, time: 2, keyframes: 2 });
        const points = () => json(scenesOf(studio)[0].keyframesJson).keyframes as Array<Record<string, number>>;
        expect(points().map((p) => p.time)).toEqual([0, 2]);
        expect(points()[1]).toMatchObject({ scale: 1.5, position_x: 10 });
        // Easing only: the keyframe at 0 gets a bezier segment.
        expect(data(await call("set_keyframe", { scene_order: 1, time: 0, easing: "bezier", bezier: [0.4, 0, 0.2, 1] }))).toMatchObject({ ok: true, easing: "bezier" });
        expect(points()[0]).toMatchObject({ bx1: 0.4, by1: 0, bx2: 0.2, by2: 1 });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(points()[0].bx1).toBeUndefined();
        expect(points()).toHaveLength(2);

        // Clips: item-local time; audio volume keyframes.
        await call("set_keyframe", { clip_id: "music", time: 1, values: { volume: 0.5 } });
        expect(json(clipOf(studio, "music")?.keyframesJson).keyframes).toEqual([{ time: 1, volume: 0.5 }]);

        expect(data(await call("set_keyframe", { scene_order: 1, time: 1 })).error).toMatch(/values or an easing/);
        expect(data(await call("set_keyframe", { scene_order: 1, time: 9, values: { scale: 2 } })).error).toMatch(/outside the item/);
        expect(data(await call("set_keyframe", { scene_order: 1, time: 1.5, easing: "linear" })).error).toMatch(/no keyframe at that time/);

        // Mask channels (phase 10c) and graphics clips.
        await call("set_keyframe", { scene_order: 1, time: 1, values: { mask_x: 0.25, mask_feather: 0.5 } });
        expect(points().find((p) => p.time === 1)).toMatchObject({ mask_x: 0.25, mask_feather: 0.5 });
        const graphics = data(await call("add_graphics_clip", { template_id: "lower-third", start_time: 4, end_time: 8 })).clipId;
        expect(data(await call("set_keyframe", { clip_id: graphics, time: 0.5, values: { opacity: 0.2 } }))).toMatchObject({ ok: true, keyframes: 1 });
        expect(json(clipOf(studio, graphics)?.keyframesJson).keyframes).toEqual([{ time: 0.5, opacity: 0.2 }]);
    },
    retime_keyframe: async (call, studio) => {
        await call("set_keyframe", { scene_order: 1, time: 1, values: { scale: 2, mask_x: 0.4 }, easing: "ease_in" });
        await call("set_keyframe", { scene_order: 1, time: 3, values: { scale: 1 } });
        const points = () => json(scenesOf(studio)[0].keyframesJson).keyframes as Array<Record<string, number>>;
        // The whole keyframe moves with its easing.
        const moved = data(await call("retime_keyframe", { scene_order: 1, from: 1, to: 2 }));
        expect(moved).toMatchObject({ ok: true, sceneId: "s1", from: 1, to: 2, keyframes: 2 });
        expect(points().map((p) => p.time)).toEqual([2, 3]);
        expect(points()[0]).toMatchObject({ scale: 2, mask_x: 0.4 });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(points().map((p) => p.time)).toEqual([1, 3]);

        // Some channels split off, with a value written at the destination.
        await call("retime_keyframe", { scene_order: 1, from: 1, to: 0.5, channels: ["mask_x"], values: { mask_x: 0.6 } });
        expect(points()).toEqual([
            expect.objectContaining({ time: 0.5, mask_x: 0.6 }),
            expect.objectContaining({ time: 1, scale: 2 }),
            expect.objectContaining({ time: 3, scale: 1 }),
        ]);
        expect(points()[1].mask_x).toBeUndefined();
        // Past the end: clamped to the item, reported as such.
        expect(data(await call("retime_keyframe", { scene_order: 1, from: 3, to: 50 }))).toMatchObject({ to: 4 });
        // Onto another keyframe: merged, so one fewer.
        expect(data(await call("retime_keyframe", { scene_order: 1, from: 0.5, to: 1 }))).toMatchObject({ keyframes: 2 });

        await call("set_keyframe", { clip_id: "title", time: 1, values: { opacity: 0.5 } });
        expect(data(await call("retime_keyframe", { clip_id: "title", from: 1, to: 2 }))).toMatchObject({ ok: true, clipId: "title", to: 2 });
        expect(data(await call("retime_keyframe", { clip_id: "title", from: 1, to: 2 })).error).toMatch(/no keyframe at that time/);
        expect(data(await call("retime_keyframe", { clip_id: "title", from: 2, to: 1, channels: ["scale"] })).error).toMatch(/none of those channels/);
        expect(data(await call("retime_keyframe", { from: 1, to: 2 })).error).toMatch(/needs clip_id or scene_order/);
        expect((await call("retime_keyframe", { clip_id: "title", from: "a", to: 2 })).isError).toBe(true);
        await lockTrack(studio, "text", 1);
        expect(data(await call("retime_keyframe", { clip_id: "title", from: 2, to: 1 })).error).toMatch(/locked track text1/);
    },
    remove_keyframe: async (call, studio) => {
        await call("set_keyframe", { clip_id: "title", time: 1, values: { scale: 2, opacity: 0.5 } });
        await call("set_keyframe", { clip_id: "title", time: 2, values: { scale: 1 } });
        const points = () => json(clipOf(studio, "title")?.keyframesJson)?.keyframes ?? [];
        expect(data(await call("remove_keyframe", { clip_id: "title", time: 1, channels: ["opacity"] }))).toMatchObject({ ok: true, keyframes: 2 });
        expect(points()[0]).toEqual({ time: 1, scale: 2 });
        await call("remove_keyframe", { clip_id: "title", time: 1 });
        expect(points()).toEqual([{ time: 2, scale: 1 }]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(points()).toHaveLength(2);
        expect(data(await call("remove_keyframe", { clip_id: "title", time: 0.5 })).error).toMatch(/no keyframe at that time/);
    },
    set_speed: async (call, studio) => {
        const fast = data(await call("set_speed", { clip_id: "music", speed: 2, preserve_pitch: false }));
        expect(fast).toMatchObject({ ok: true, speed: 2, length: 7.5, curve: null });
        expect(clipOf(studio, "music")).toMatchObject({ playbackSpeed: 2, endTime: 7.5, preservePitch: false });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "music")).toMatchObject({ playbackSpeed: 1, endTime: 15 });

        // A curve preset changes the length by 1 / mean speed; "none" takes it off.
        const hero = data(await call("set_speed", { clip_id: "music", curve_id: "hero" }));
        expect(hero.curve).toBe("hero");
        expect(hero.length).toBeGreaterThan(15);
        expect(json(clipOf(studio, "music")?.speedCurveJson)).toMatchObject({ id: "hero" });
        await call("set_speed", { clip_id: "music", curve_id: "none" });
        expect(clipOf(studio, "music")?.speedCurveJson ?? null).toBeNull();
        expect(clipOf(studio, "music")?.endTime).toBeCloseTo(15, 2);
        const custom = data(await call("set_speed", { clip_id: "music", curve_points: [[0, 2], [1, 2]] }));
        expect(custom).toMatchObject({ curve: "custom", length: 7.5 });

        // A main-track clip: its length follows and later scenes move.
        const scene = data(await call("set_speed", { scene_order: 1, speed: 0.5 }));
        expect(scene).toMatchObject({ ok: true, speed: 0.5, length: 8 });
        expect(scenesOf(studio)[0].playbackSpeed).toBe(0.5);

        expect(data(await call("set_speed", { clip_id: "title", speed: 2 })).error).toMatch(/text clip/);
        expect(data(await call("set_speed", { clip_id: "music", curve_id: "hero", curve_points: [[0, 1], [1, 1]] })).error).toMatch(/curve_id or curve_points/);
        expect(data(await call("set_speed", { clip_id: "music" })).error).toMatch(/speed, curve_id, curve_points, or preserve_pitch/);

        // Several clips in one step (one undo).
        const rows = studio.controller.snapshot().tracks;
        const created = await studio.controller.execute({
            type: "clip.create",
            tracks: [...rows, { type: "audio" as const, index: 2, label: "A2", muted: false, locked: false, visible: true, volume: 1 }],
            input: { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "https://media.test/sfx.mp3" },
        });
        const sfx = created.createdClipIds![0];
        await call("set_speed", { clip_id: "music", speed: 1, curve_id: "none" });
        const both = data(await call("set_speed", { clip_ids: ["music", sfx], speed: 2 }));
        expect(both).toMatchObject({ ok: true, clipIds: ["music", sfx], clips: [{ clipId: "music", speed: 2, length: 7.5 }, { clipId: sfx, speed: 2, length: 2 }] });
        expect(clipOf(studio, sfx)).toMatchObject({ playbackSpeed: 2, endTime: 2 });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, sfx)).toMatchObject({ playbackSpeed: 1, endTime: 4 });
        expect(clipOf(studio, "music")?.playbackSpeed).toBe(1);
        expect(data(await call("set_speed", { clip_ids: ["music", "title"], speed: 2 })).error).toMatch(/text clip/);
        expect(data(await call("set_speed", { clip_ids: ["music"], clip_id: "music", speed: 2 })).error).toMatch(/clip_ids, clip_id, or scene_order/);
    },
    apply_caption_style: async (call, studio) => {
        expect(data(await call("apply_caption_style", { style_id: "pill" })).error).toMatch(/no caption clips/);
        const rows = studio.controller.snapshot().tracks;
        const created = await studio.controller.execute({
            type: "clip.create",
            tracks: [...rows, ...[2, 3].map((index) => ({ type: "text" as const, index, label: `T${index}`, muted: false, locked: false, visible: true, volume: 1 }))],
            input: [
                { trackType: "text", trackIndex: 2, startTime: 0, endTime: 2, textContent: "one two", textStyle: JSON.stringify({ textClipKind: "caption", captionKind: "caption" }) },
                { trackType: "text", trackIndex: 3, startTime: 0, endTime: 2, textContent: "three", textStyle: JSON.stringify({ textClipKind: "caption", captionKind: "caption" }) },
            ],
        });
        const [a, b] = created.createdClipIds!;
        const applied = data(await call("apply_caption_style", { style_id: "karaoke_box" }));
        expect(applied).toMatchObject({ ok: true, styleId: "karaoke_box", clipIds: [a, b] });
        expect(style(studio, a)).toMatchObject({ karaoke: "box", highlightColor: "#7C3AED" });
        expect(style(studio, "title").karaoke).toBeUndefined();
        // One track only, then undo.
        await call("apply_caption_style", { style_id: "neon", track_index: 3 });
        expect(style(studio, b)).toMatchObject({ glowColor: "#00E5FF" });
        expect(style(studio, a).karaoke).toBe("box");
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(style(studio, b)).toMatchObject({ karaoke: "box" });
        // Given clips (a plain text clip too, which becomes a caption); locked tracks are skipped.
        await call("apply_caption_style", { style_id: "bold_yellow", clip_ids: ["title"] });
        expect(style(studio, "title")).toMatchObject({ color: "#FFE14D", textClipKind: "caption" });
        await lockTrack(studio, "text", 2);
        const skipped = data(await call("apply_caption_style", { style_id: "minimal" }));
        expect(skipped).toMatchObject({ clipIds: ["title", b], skipped: [a] });
        expect(style(studio, a).karaoke).toBe("box");
    },
};

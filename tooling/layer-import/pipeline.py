"""Flat image -> layered design (the LayerDesign JSON of @opennan/timeline-core/design/model).

Steps (fal endpoints; prices from the fal pricing API, October 2026):
  1. read text      Florence-2 OCR with regions            ~$0.005
  2. erase text     image-editing/text-removal ($0.04), aligned back and pasted only inside the
                    text boxes; areas whose fill changed material (sky where a plate was) are
                    re-filled locally from a tight letter mask
  3. split layers   Qwen-Image-Layered ($0.05); its alpha and hidden-part completion are kept,
                    visible pixels come from the full-resolution clean plate
  4. cut letters    every text keeps its original word image and per-character cells, so edits
                    are rebuilt from the real lettering; a font is matched only as a fallback
"""
import io
import json
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import fal_client as fal

MAX_SIDE = 1600
FONT_DIR = os.path.join(os.path.dirname(__file__), ".fonts")
FALLBACK_FONTS = [
    ("Roboto", 700), ("Lato", 900), ("Montserrat", 700), ("Poppins", 700), ("Open Sans", 700), ("Oswald", 700),
    ("Bebas Neue", 400), ("Cinzel", 700), ("Merriweather", 900), ("Playfair Display", 700), ("Rosario", 700),
    ("Alegreya SC", 700), ("Andada Pro", 800), ("Lilita One", 400), ("Kanit", 600), ("Prompt", 700),
]
COST = {"ocr": 0.005, "erase": 0.04, "layers": 0.05}


def _hex(bgr):
    b, g, r = [int(v) for v in bgr]
    return f"#{r:02x}{g:02x}{b:02x}"


def _hex_bgr(h):
    h = h.lstrip("#")
    return np.array([int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)], np.float32)


def _colour_distance(a, b):
    return float(np.linalg.norm(_hex_bgr(a) - _hex_bgr(b)))


def _webp(path, rgba_or_bgr):
    arr = rgba_or_bgr
    if arr.ndim == 3 and arr.shape[2] == 4:
        img = Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_BGRA2RGBA))
    else:
        img = Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_BGR2RGB))
    img.save(path, "WEBP", lossless=True, method=4)


# ── 1. read text ─────────────────────────────────────────


def read_text(img):
    r = fal.run("fal-ai/florence-2-large/ocr-with-region", {"image_url": fal.data_uri(img)})
    texts = []
    for q in r.get("results", {}).get("quad_boxes", []):
        t = q["label"].replace("</s>", "").replace("<s>", "").strip()
        if not t or not any(ch.isalnum() for ch in t):
            continue  # icons read as "+" etc.
        texts.append({"text": t, "x": q["x"], "y": q["y"], "w": q["w"], "h": q["h"]})
    return texts


def text_mask(size, texts):
    from PIL import ImageFilter
    W, H = size
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    for t in texts:
        pad = max(3, t["h"] * 0.18)
        d.rectangle([t["x"] - pad, t["y"] - pad, t["x"] + t["w"] + pad, t["y"] + t["h"] + pad], fill=255)
    return np.asarray(mask.filter(ImageFilter.MaxFilter(5))) > 0


# ── 2. erase text ────────────────────────────────────────


def _align(ref, moving, keep):
    """Affine-align `moving` to `ref` using only pixels in `keep`; identity when ECC fails."""
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6)
        _, warp = cv2.findTransformECC(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY).astype(np.float32),
                                       cv2.cvtColor(moving, cv2.COLOR_BGR2GRAY).astype(np.float32),
                                       warp, cv2.MOTION_AFFINE, crit, keep, 5)
    except cv2.error:
        pass
    return warp


def erase_text(src, img, mask):
    H, W = src.shape[:2]
    r = fal.run("fal-ai/image-editing/text-removal", {"image_url": fal.data_uri(img), "output_format": "png"})
    edited = cv2.imdecode(np.frombuffer(fal.download(r["images"][0]["url"]), np.uint8), cv2.IMREAD_COLOR)
    edited = cv2.resize(edited, (W, H), interpolation=cv2.INTER_AREA)
    warp = _align(src, edited, (~mask).astype(np.uint8))
    edited = cv2.warpAffine(edited, warp, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)
    a = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 3)[..., None]
    a = np.clip(a * 1.6, 0, 1)
    clean = (edited * a + src * (1 - a)).astype(np.uint8)
    return _refill_wrong_material(src, clean, mask.astype(np.uint8))


def _refill_wrong_material(src, clean, mask):
    n, lab = cv2.connectedComponents(mask)
    out = clean.copy()
    lum = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY).astype(int)
    for c in range(1, n):
        comp = (lab == c).astype(np.uint8)
        ring = cv2.dilate(comp, np.ones((7, 7), np.uint8)) - comp
        if ring.sum() == 0:
            continue
        gen = np.median(clean[comp > 0].reshape(-1, 3).astype(int), axis=0)
        around = np.median(src[ring > 0].reshape(-1, 3).astype(int), axis=0)
        if np.abs(gen - around).sum() <= 180:
            continue
        letters = ((np.abs(lum - np.median(lum[comp > 0])) > 45) & (comp > 0)).astype(np.uint8)
        letters = cv2.dilate(letters, np.ones((7, 7), np.uint8))
        local = cv2.inpaint(src, letters * 255, 5, cv2.INPAINT_TELEA)
        sel = comp > 0
        out[sel] = np.where(letters[sel][:, None] > 0, local[sel], src[sel])
    return out


# ── 3. split layers ──────────────────────────────────────


def split_layers(clean, num_layers=6):
    img = Image.fromarray(cv2.cvtColor(clean, cv2.COLOR_BGR2RGB))
    r = fal.run("fal-ai/qwen-image-layered", {"image_url": fal.data_uri(img), "num_layers": num_layers,
                                              "num_inference_steps": 50, "guidance_scale": 4, "acceleration": "none"})
    return [cv2.imdecode(np.frombuffer(fal.download(i["url"]), np.uint8), cv2.IMREAD_UNCHANGED) for i in r["images"]]


def build_elements(clean, layers, out_dir):
    H, W = clean.shape[:2]
    layers = [L if L.shape[2] == 4 else cv2.cvtColor(L, cv2.COLOR_BGR2BGRA) for L in layers]
    comp = np.zeros((*layers[0].shape[:2], 3), np.float32)
    for L in layers:
        a = L[..., 3:4] / 255.0
        comp = L[..., :3] * a + comp * (1 - a)
    comp = cv2.resize(comp.astype(np.uint8), (W, H), interpolation=cv2.INTER_CUBIC)
    warp = _align(clean, comp, None)

    def frame(img):
        up = cv2.resize(img, (W, H), interpolation=cv2.INTER_CUBIC)
        return cv2.warpAffine(up, warp, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)

    ql = [frame(L) for L in layers]
    alpha = [L[..., 3].astype(np.float32) / 255 for L in ql]
    above, acc = [None] * len(ql), np.zeros((H, W), np.float32)
    for i in range(len(ql) - 1, -1, -1):
        above[i] = acc.copy()
        acc = acc + alpha[i] * (1 - acc)

    vis0 = np.clip(1 - above[0], 0, 1)[..., None]
    _webp(os.path.join(out_dir, "background.webp"), (clean * vis0 + ql[0][..., :3] * (1 - vis0)).astype(np.uint8))
    elements = [{"id": "background", "kind": "background", "src": "background.webp", "x": 0, "y": 0, "w": W, "h": H, "z": 0}]
    z = 1
    for i in range(1, len(ql)):
        a = alpha[i]
        solid = (a > 0.5).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(solid, np.ones((7, 7), np.uint8)), 8)
        for c in range(1, n):
            x, y, w, h, area = stats[c]
            region = lab == c
            if area < 250 or solid[region].sum() < 150:
                continue
            a_el = np.where(region, a, 0)
            ff = (a_el > 0.5).astype(np.uint8)
            cv2.floodFill(ff, np.zeros((H + 2, W + 2), np.uint8), (0, 0), 2)
            holes = (ff == 0) & region
            a_el = np.where(holes, 1.0, a_el)
            kind = "shadow" if a_el.max() < 0.6 else "element"
            vis = np.where(holes, 1.0, np.clip(1 - above[i], 0, 1))[..., None]
            rgb = (clean * vis + ql[i][..., :3] * (1 - vis)).astype(np.uint8)
            a8 = np.clip((a_el - 0.5) * 1.6 + 0.5, 0, 1) if kind == "element" else a_el
            eid = f"L{i}_{c}"
            _webp(os.path.join(out_dir, f"{eid}.webp"), np.dstack([rgb, (a8 * 255).astype(np.uint8)])[y:y + h, x:x + w])
            elements.append({"id": eid, "kind": kind, "src": f"{eid}.webp", "x": int(x), "y": int(y), "w": int(w), "h": int(h), "z": z})
            z += 1
    # groups: union pieces that mostly overlap (a tile frame and its icon)
    parent = {e["id"]: e["id"] for e in elements}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    fg = elements[1:]
    for i, a_ in enumerate(fg):
        for b in fg[i + 1:]:
            ix = max(0, min(a_["x"] + a_["w"], b["x"] + b["w"]) - max(a_["x"], b["x"]))
            iy = max(0, min(a_["y"] + a_["h"], b["y"] + b["h"]) - max(a_["y"], b["y"]))
            if ix * iy > 0.55 * min(a_["w"] * a_["h"], b["w"] * b["h"]):
                parent[find(a_["id"])] = find(b["id"])
    for e in fg:
        e["group"] = "G_" + find(e["id"])
    return elements


# ── 4. text styles, letters, fallback font ──────────────


def text_style(src, clean, t):
    H, W = src.shape[:2]
    X0, Y0 = max(0, int(t["x"]) - 4), max(0, int(t["y"]) - 4)
    X1, Y1 = min(W, int(np.ceil(t["x"] + t["w"])) + 4), min(H, int(np.ceil(t["y"] + t["h"])) + 4)
    crop = src[Y0:Y1, X0:X1].reshape(-1, 3)
    d = np.abs(src[Y0:Y1, X0:X1].astype(int) - clean[Y0:Y1, X0:X1].astype(int)).sum(axis=2).reshape(-1)
    ink = crop[d > 60].astype(np.float32)
    style = {"fill": "#ffffff", "strokeWidth": 0, "shadow": True, "track": 0}
    if len(ink) > 20:
        # fill = the ink colour furthest from the background (white text on a dark tile, navy text on a white
        # slide); the other cluster is an outline only when it is far from both the fill and the background
        bg = np.median(clean[Y0:Y1, X0:X1].reshape(-1, 3).astype(np.float32), axis=0)
        _, labels, centers = cv2.kmeans(ink, 2, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 4, cv2.KMEANS_PP_CENTERS)
        counts = np.bincount(labels.ravel(), minlength=2)
        far = [float(np.linalg.norm(c - bg)) for c in centers]
        fi = int(np.argmax(far))
        oi = 1 - fi
        style["fill"] = _hex(centers[fi])
        gap = float(np.linalg.norm(centers[oi] - centers[fi]))
        between = far[oi] + gap < 1.2 * far[fi]  # the soft edge between fill and background, not an outline
        if gap > 80 and far[oi] > 60 and not between and counts[oi] > 0.15 * len(ink):
            style["stroke"] = _hex(centers[oi])
            style["strokeWidth"] = max(1.0, round(t["h"] * 0.06, 1))
        style["shadow"] = bool(style.get("stroke"))
    return style


def style_groups(texts):
    """Texts that can share letters: close fill colour and similar height."""
    gid, groups = {}, []
    for i, t in enumerate(texts):
        for g in groups:
            r = texts[g[0]]
            ratio = t["h"] / r["h"]
            if 0.8 <= ratio <= 1.25 and _colour_distance(t["style"]["fill"], r["style"]["fill"]) < 50:
                g.append(i)
                break
        else:
            groups.append([i])
    for n, g in enumerate(groups):
        for i in g:
            gid[i] = f"s{n}"
    return gid


def cut_letters(src, clean, t, out_dir, tid, font_path, track):
    """Whole word + per-character RGBA cells (outline and shadow included)."""
    H, W = src.shape[:2]
    srcf, cleanf = src.astype(np.float32), clean.astype(np.float32)
    pad = max(3, int(t["h"] * 0.25))
    x0, y0 = max(0, int(t["x"]) - pad), max(0, int(t["y"]) - pad)
    x1, y1 = min(W, int(np.ceil(t["x"] + t["w"])) + pad), min(H, int(np.ceil(t["y"] + t["h"])) + pad)
    s, c = srcf[y0:y1, x0:x1], cleanf[y0:y1, x0:x1]
    diff = np.abs(s - c).max(axis=2)
    alpha = np.clip((diff - 22) / 55, 0, 1)
    rgb = np.clip((s - (1 - alpha[..., None]) * c) / np.maximum(alpha[..., None], 1e-3), 0, 255)
    rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    fill = _hex_bgr(t["style"]["fill"])
    fm = ((np.linalg.norm(s - fill, axis=2) < np.linalg.norm(s - c, axis=2)) & (diff > 25)).astype(np.uint8)
    if t["style"].get("stroke"):
        fm &= (np.linalg.norm(s - fill, axis=2) < np.linalg.norm(s - _hex_bgr(t["style"]["stroke"]), axis=2)).astype(np.uint8)
    own = np.zeros_like(fm)
    bx0, by0 = int(t["x"]) - x0, int(t["y"]) - y0
    own[max(0, by0 - 1):by0 + int(np.ceil(t["h"])) + 2, max(0, bx0 - 1):bx0 + int(np.ceil(t["w"])) + 2] = 1
    fm &= own
    halo = cv2.dilate(fm, np.ones((max(3, int(t["h"] * 0.22)) | 1,) * 2, np.uint8))
    halo = cv2.GaussianBlur(halo.astype(np.float32), (0, 0), 1.0)
    rgba[..., 3] = (rgba[..., 3].astype(np.float32) * np.clip(halo * 1.5, 0, 1)).astype(np.uint8)
    word_src = f"{tid}_word.webp"
    _webp(os.path.join(out_dir, word_src), rgba)
    word = {"src": word_src, "dx": x0 - t["x"], "dy": y0 - t["y"], "w": x1 - x0, "h": y1 - y0}

    chars = [ch for ch in t["text"] if ch != " "]
    n, lab, st, _ = cv2.connectedComponentsWithStats(fm, 8)
    comps = sorted([list(st[i][:4]) for i in range(1, n) if st[i][4] >= max(4, t["h"] * 0.4)], key=lambda b: b[0])
    merged = []
    for b in comps:
        if merged and b[0] < merged[-1][0] + merged[-1][2] - 1:
            m = merged[-1]
            nx0, nx1 = min(m[0], b[0]), max(m[0] + m[2], b[0] + b[2])
            merged[-1] = [nx0, 0, nx1 - nx0, 0]
        else:
            merged.append(b)
    cols = fm.sum(axis=0)
    if len(merged) == len(chars):
        cuts = [0] + [int(round((a[0] + a[2] + b[0]) / 2)) for a, b in zip(merged, merged[1:])] + [rgba.shape[1]]
    elif font_path and " " not in t["text"] and len(chars) > 1:
        f = ImageFont.truetype(font_path, 200)
        xs = np.nonzero(cols)[0]
        if len(xs) == 0:
            return word, None
        ink0, ink1 = xs.min(), xs.max() + 1
        ext, x = [], 0.0
        for ch in t["text"]:
            l, _, r, _ = f.getbbox(ch)
            ext.append((x + l, x + r))
            x += f.getlength(ch) + track * 200
        f0, f1 = ext[0][0], ext[-1][1]
        sc = (ink1 - ink0) / max(1e-6, f1 - f0)
        cuts = [0]
        for (_, a1), (b0, _) in zip(ext, ext[1:]):
            guess = ink0 + ((a1 + b0) / 2 - f0) * sc
            rad = max(2, int(t["h"] * 0.18))
            lo = max(0, int(guess) - rad)
            win = cols[lo:int(guess) + rad + 1]
            cuts.append(lo + int(np.argmin(win)) if len(win) else int(guess))
        cuts.append(rgba.shape[1])
    else:
        return word, None
    # ink extent of each letter inside its cell, and the word's typical letter gap (not across spaces)
    inks = []
    for i in range(len(chars)):
        seg = np.nonzero(cols[cuts[i]:cuts[i + 1]])[0]
        inks.append((cuts[i] + int(seg.min()), int(seg.max() - seg.min() + 1)) if len(seg) else (cuts[i], max(1, cuts[i + 1] - cuts[i])))
    word_breaks, k = set(), 0
    for ch in t["text"]:
        if ch == " ":
            word_breaks.add(k)
        else:
            k += 1
    gaps = [inks[i + 1][0] - (inks[i][0] + inks[i][1]) for i in range(len(inks) - 1) if (i + 1) not in word_breaks]
    word["gap"] = float(np.median(gaps)) if gaps else None
    glyphs = []
    for i, ch in enumerate(chars):
        g = rgba[:, cuts[i]:cuts[i + 1]]
        if g.shape[1] < 1:
            return word, None
        name = f"{tid}_{i}.webp"
        _webp(os.path.join(out_dir, name), g)
        glyphs.append({"ch": ch, "src": name, "dx": x0 + cuts[i] - t["x"], "dy": y0 - t["y"], "w": int(g.shape[1]), "h": int(g.shape[0]),
                       "ink": {"x": inks[i][0] - cuts[i], "w": inks[i][1]}})
    return word, glyphs


def _font_path(family, weight):
    import re
    import urllib.parse
    import requests
    os.makedirs(FONT_DIR, exist_ok=True)
    path = os.path.join(FONT_DIR, f"{family.replace(' ', '_')}_{weight}.ttf")
    if not os.path.exists(path):
        css = requests.get(f"https://fonts.googleapis.com/css2?family={urllib.parse.quote(family)}:wght@{weight}", headers={"User-Agent": "curl/8.0"}, timeout=30)
        m = re.search(r"src:\s*url\((.*?)\)", css.text) if css.ok else None
        if not m:
            return None
        open(path, "wb").write(requests.get(m.group(1), timeout=60).content)
    return path


def match_font(src, clean, t):
    """Closest fallback font by rendered shape (fill mask vs. candidate render), with its letter spacing."""
    pad = 3
    x0, y0 = int(t["x"]) - pad, int(t["y"]) - pad
    x1, y1 = int(np.ceil(t["x"] + t["w"])) + pad, int(np.ceil(t["y"] + t["h"])) + pad
    s, c = src[y0:y1, x0:x1].astype(np.float32), clean[y0:y1, x0:x1].astype(np.float32)
    fill = _hex_bgr(t["style"]["fill"])
    m = ((np.linalg.norm(s - fill, axis=2) < np.linalg.norm(s - c, axis=2)) & (np.abs(s - c).sum(axis=2) > 50)).astype(np.uint8)
    ys, xs = np.nonzero(m)
    if len(xs) < 20:
        return "Roboto", 700, 0.0, _font_path("Roboto", 700)
    tm = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    th, tw = tm.shape
    best = None
    for fam, w in FALLBACK_FONTS:
        p = _font_path(fam, w)
        if not p:
            continue
        f = ImageFont.truetype(p, 120)
        try:
            l, tp, r, b = f.getbbox(t["text"])
        except Exception:
            continue
        im = Image.new("L", (r - l + 10, b - tp + 10), 0)
        ImageDraw.Draw(im).text((5 - l, 5 - tp), t["text"], font=f, fill=255)
        cm = np.asarray(im) > 127
        cys, cxs = np.nonzero(cm)
        if len(cxs) == 0:
            continue
        cm = cm[cys.min():cys.max() + 1, cxs.min():cxs.max() + 1].astype(np.uint8)
        stretch = (tw / th) / (cm.shape[1] / cm.shape[0])
        cm = cv2.resize(cm, (tw, th), interpolation=cv2.INTER_NEAREST)
        a = cv2.GaussianBlur(tm.astype(np.float32), (0, 0), 0.7)
        bb = cv2.GaussianBlur(cm.astype(np.float32), (0, 0), 0.7)
        score = np.minimum(a, bb).sum() / (np.maximum(a, bb).sum() + 1e-6) - 0.9 * abs(np.log(stretch))
        track = (stretch - 1) * 0.12 if len(t["text"]) > 1 else 0.0
        if best is None or score > best[0]:
            best = (score, fam, w, float(np.clip(track, -0.05, 0.3)), p)
    if not best:
        return "Roboto", 700, 0.0, _font_path("Roboto", 700)
    return best[1], best[2], best[3], best[4]


# ── whole pipeline ───────────────────────────────────────


def run(image_bytes, out_dir, progress=lambda step, cost: None):
    os.makedirs(out_dir, exist_ok=True)
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    W, H = img.size
    src = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
    img.save(os.path.join(out_dir, "source.webp"), "WEBP", quality=90)
    cost = 0.0

    progress("read_text", cost)
    texts = read_text(img)
    cost += COST["ocr"]

    progress("erase_text", cost)
    if texts:
        clean = erase_text(src, img, text_mask((W, H), texts))
        cost += COST["erase"]
    else:
        clean = src.copy()

    progress("split_layers", cost)
    elements = build_elements(clean, split_layers(clean), out_dir)
    cost += COST["layers"]

    progress("cut_letters", cost)
    for t in texts:
        t["style"] = text_style(src, clean, t)
    sg = style_groups(texts)
    layers = []
    for e in sorted(elements, key=lambda e: e["z"]):
        layer = {"id": e["id"], "kind": "image", "src": e["src"], "role": "background" if e["kind"] == "background" else e["kind"],
                 "box": {"x": e["x"], "y": e["y"], "w": e["w"], "h": e["h"]}}
        if e["kind"] == "background":
            layer["locked"] = True
        if e.get("group"):
            layer["group"] = e["group"]
        layers.append(layer)
    solid = [e for e in elements if e["kind"] == "element"]
    for k, t in enumerate(texts):
        tid = f"T{k}"
        fam, weight, track, fpath = match_font(src, clean, t)
        word, glyphs = cut_letters(src, clean, t, out_dir, tid, fpath, track)
        gap = word.pop("gap", None)
        style = {**t["style"], "font": fam, "weight": weight, "track": round(track, 3)}
        layer = {"id": tid, "kind": "text", "text": t["text"], "lettering": "auto", "styleGroup": sg[k],
                 "box": {"x": t["x"], "y": t["y"], "w": t["w"], "h": t["h"]},
                 "original": {"text": t["text"], "word": word, **({"glyphs": glyphs, **({"gap": gap} if gap is not None else {})} if glyphs else {})}, "style": style}
        cx, cy = t["x"] + t["w"] / 2, t["y"] + t["h"] / 2
        under = [e for e in solid if e["x"] <= cx <= e["x"] + e["w"] and e["y"] <= cy <= e["y"] + e["h"]]
        if under:
            layer["group"] = min(under, key=lambda e: e["w"] * e["h"])["group"]
        layers.append(layer)
    design = {"version": 1, "width": W, "height": H, "source": "source.webp", "layers": layers}
    with open(os.path.join(out_dir, "design.json"), "w") as f:
        json.dump(design, f, indent=1)
    progress("done", cost)
    return design, cost

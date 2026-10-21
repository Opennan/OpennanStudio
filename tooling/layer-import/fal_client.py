"""Minimal fal.ai queue client: submit, poll, fetch. Images go in as data URIs."""
import base64
import io
import os
import time

import requests

QUEUE = "https://queue.fal.run"


def _headers():
    key = os.environ.get("FAL_KEY")
    if not key:
        raise RuntimeError("FAL_KEY is not set; export your fal.ai key before starting the service")
    return {"Authorization": f"Key {key}", "Content-Type": "application/json"}


CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")


def run(model, payload, timeout=600):
    """Same model + same input returns the cached answer (dev re-runs of one image cost nothing)."""
    import hashlib
    import json
    key = hashlib.sha256((model + json.dumps(payload, sort_keys=True)).encode()).hexdigest()
    cached = os.path.join(CACHE_DIR, f"{key}.json")
    if os.path.exists(cached):
        with open(cached) as f:
            return json.load(f)
    result = _run(model, payload, timeout)
    # fal file URLs expire; keep the bytes
    for img in result.get("images", []) if isinstance(result.get("images"), list) else []:
        if isinstance(img, dict) and img.get("url", "").startswith("http"):
            img["url"] = "data:image/png;base64," + base64.b64encode(download(img["url"])).decode()
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cached, "w") as f:
        json.dump(result, f)
    return result


def _run(model, payload, timeout):
    h = _headers()
    r = requests.post(f"{QUEUE}/{model}", headers=h, json=payload, timeout=60)
    r.raise_for_status()
    job = r.json()
    t0 = time.time()
    while True:
        s = requests.get(job["status_url"], headers=h, timeout=60).json()
        if s.get("status") == "COMPLETED":
            break
        if time.time() - t0 > timeout:
            requests.put(job["cancel_url"], headers=h, timeout=30)
            raise TimeoutError(f"{model} did not finish in {timeout}s")
        time.sleep(1.5)
    out = requests.get(job["response_url"], headers=h, timeout=120)
    if out.status_code >= 400:
        raise RuntimeError(f"{model} failed: {out.status_code} {out.text[:300]}")
    return out.json()


def data_uri(img, fmt="PNG"):
    buf = io.BytesIO()
    img.save(buf, fmt)
    mime = "image/png" if fmt == "PNG" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode()


def download(url):
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    return requests.get(url, timeout=120).content

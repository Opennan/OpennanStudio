"""Local layer-import service for the playground (dev only; fal bills the FAL_KEY of whoever runs it).

  POST /import          body = image bytes (PNG/JPEG/WebP, ≤ 15 MB)  -> {"id": "..."}
  GET  /jobs/<id>       -> {"status": "running"|"done"|"error", "step": "...", "costUsd": 0.095,
                            "designUrl": "/layer-imports/<id>/design.json", "error": "..."}

Results are written to apps/playground/public/layer-imports/<id>/ so the playground's dev server serves them.
Run:  FAL_KEY=... python3 tooling/layer-import/serve.py
"""
import json
import os
import sys
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import pipeline  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "playground", "public", "layer-imports")
PORT = int(os.environ.get("LAYER_IMPORT_PORT", "4318"))
MAX_BYTES = 15 * 1024 * 1024
ALLOWED_ORIGINS = {"http://localhost:4317", "http://127.0.0.1:4317"}
JOBS = {}
LOCK = threading.Lock()


def work(job_id, data):
    def progress(step, cost):
        with LOCK:
            JOBS[job_id].update(step=step, costUsd=round(cost, 4))

    try:
        _, cost = pipeline.run(data, os.path.join(OUT, job_id), progress)
        with LOCK:
            JOBS[job_id].update(status="done", costUsd=round(cost, 4), designUrl=f"/layer-imports/{job_id}/design.json")
    except Exception as e:  # report every failure to the page
        traceback.print_exc()
        with LOCK:
            JOBS[job_id].update(status="error", error=str(e))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/import":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, {"error": "send one image of at most 15 MB"})
        if not (self.headers.get("Content-Type") or "").startswith("image/"):
            return self._json(415, {"error": "send PNG, JPEG or WebP image bytes"})
        data = self.rfile.read(n)
        job_id = uuid.uuid4().hex[:12]
        with LOCK:
            JOBS[job_id] = {"status": "running", "step": "queued", "costUsd": 0}
        threading.Thread(target=work, args=(job_id, data), daemon=True).start()
        self._json(202, {"id": job_id})

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "falKey": bool(os.environ.get("FAL_KEY"))})
        if self.path.startswith("/jobs/"):
            with LOCK:
                job = JOBS.get(self.path.split("/")[-1])
            return self._json(200, job) if job else self._json(404, {"error": "no such job"})
        self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[layer-import] " + (fmt % args) + "\n")


if __name__ == "__main__":
    if not os.environ.get("FAL_KEY"):
        sys.exit("Set FAL_KEY first: export FAL_KEY=your-fal-key")
    os.makedirs(OUT, exist_ok=True)
    print(f"[layer-import] http://127.0.0.1:{PORT}  (results in {OUT})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

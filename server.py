#!/usr/bin/env python3
"""Local Nearfield server with a private Demucs separation endpoint."""

from __future__ import annotations

import cgi
import hashlib
import json
import re
import shutil
import subprocess
import threading
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
RUNTIME = ROOT / ".runtime"
PYTHON = ROOT / ".venv" / "bin" / "python"
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MODEL_LOCK = threading.Semaphore(1)
LYRICS_LOCK = threading.Semaphore(1)


def update_job(job_id: str, **values) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(values)


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return round(float(result.stdout.strip()), 3)


def separate(job_id: str, source: Path, title: str) -> None:
    output_root = RUNTIME / "separated" / job_id
    public_root = DIST / "assets" / "generated" / job_id
    try:
        update_job(job_id, state="processing", message="AI отделяет вокал, бас, ударные и инструменты")
        with MODEL_LOCK:
            command = [
                str(PYTHON), "-m", "demucs", "-n", "htdemucs", "-d", "mps",
                "--mp3", "--mp3-bitrate", "192", "--mp3-preset", "4", "-o", str(output_root), str(source),
            ]
            process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        if process.returncode:
            raise RuntimeError(process.stderr.strip()[-1200:] or "Demucs завершился с ошибкой")
        stem_files = {}
        public_root.mkdir(parents=True, exist_ok=True)
        for stem in ("vocals", "bass", "drums", "other"):
            matches = list(output_root.rglob(f"{stem}.mp3"))
            if not matches:
                raise RuntimeError(f"Не найдена дорожка {stem}")
            destination = public_root / f"{stem}.mp3"
            shutil.copy2(matches[0], destination)
            stem_files[stem] = f"assets/generated/{job_id}/{stem}.mp3"
        update_job(
            job_id,
            state="done",
            message="Готово",
            track={
                "title": title,
                "artist": "Локальный AI-разбор",
                "album": "Demucs · 4 stems",
                "duration": probe_duration(public_root / "vocals.mp3"),
                "stems": stem_files,
            },
        )
    except Exception as error:  # the message is returned only to localhost
        update_job(job_id, state="error", message=str(error))


def lyrics_cache(source: Path) -> Path:
    stat = source.stat()
    key = hashlib.sha1(f"{source.relative_to(DIST)}|{stat.st_size}|{int(stat.st_mtime)}".encode()).hexdigest()[:16]
    return RUNTIME / "lyrics" / f"{key}.json"


def transcribe(job_id: str, source: Path, target: Path) -> None:
    try:
        update_job(job_id, state="processing", message="Whisper распознаёт текст")
        target.parent.mkdir(parents=True, exist_ok=True)
        with LYRICS_LOCK:
            process = subprocess.run([str(PYTHON), str(ROOT / "lyrics_worker.py"), str(source), str(target)], cwd=ROOT, capture_output=True, text=True)
        if process.returncode == 3:
            raise RuntimeError("Распознавание не установлено: .venv/bin/pip install faster-whisper")
        if process.returncode:
            raise RuntimeError(process.stderr.strip()[-800:] or "Whisper завершился с ошибкой")
        update_job(job_id, state="done", message="Готово", lyrics=json.loads(target.read_text(encoding="utf-8")))
    except Exception as error:  # the message is returned only to localhost
        update_job(job_id, state="error", message=str(error))


class NearfieldHandler(SimpleHTTPRequestHandler):
    server_version = "Nearfield/1.0"

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        # Always revalidate static files so updated JS modules are picked up without a hard reload.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/api/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                payload = dict(job) if job else None
            self.send_json(payload or {"state": "error", "message": "Задача не найдена"}, 200 if payload else 404)
            return
        super().do_GET()

    def start_lyrics(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(min(length, 4096)) or b"{}")
            source = (DIST / str(payload.get("path", ""))).resolve()
            source.relative_to(DIST.resolve())
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Неверный путь"}, 400)
            return
        if not source.is_file():
            self.send_json({"error": "Вокальная дорожка не найдена"}, 404)
            return
        cached = lyrics_cache(source)
        if cached.exists():
            self.send_json({"state": "done", "lyrics": json.loads(cached.read_text(encoding="utf-8"))})
            return
        if not PYTHON.exists():
            self.send_json({"error": "AI-окружение не установлено (.venv)"}, 503)
            return
        job_id = uuid.uuid4().hex[:12]
        with JOBS_LOCK:
            JOBS[job_id] = {"state": "queued", "message": "Текст в очереди"}
        threading.Thread(target=transcribe, args=(job_id, source, cached), daemon=True).start()
        self.send_json({"jobId": job_id}, 202)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/api/lyrics":
            self.start_lyrics()
            return
        if urlparse(self.path).path != "/api/separate":
            self.send_json({"error": "Not found"}, 404)
            return
        if not PYTHON.exists():
            self.send_json({"error": "AI-окружение не установлено"}, 503)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 250 * 1024 * 1024:
            self.send_json({"error": "Файл пустой или больше 250 МБ"}, 413)
            return
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "")},
        )
        upload = form["file"] if "file" in form else None
        if upload is None or not getattr(upload, "file", None):
            self.send_json({"error": "Аудиофайл не найден"}, 400)
            return
        original = Path(upload.filename or "track.mp3")
        safe_stem = re.sub(r"[^\w .-]+", "_", original.stem, flags=re.UNICODE).strip()[:90] or "track"
        suffix = original.suffix.lower() if original.suffix.lower() in {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"} else ".audio"
        job_id = uuid.uuid4().hex[:12]
        upload_dir = RUNTIME / "uploads" / job_id
        upload_dir.mkdir(parents=True, exist_ok=True)
        source = upload_dir / f"{safe_stem}{suffix}"
        with source.open("wb") as target:
            shutil.copyfileobj(upload.file, target)
        with JOBS_LOCK:
            JOBS[job_id] = {"state": "queued", "message": "Трек в очереди"}
        threading.Thread(target=separate, args=(job_id, source, safe_stem), daemon=True).start()
        self.send_json({"jobId": job_id}, 202)

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")


if __name__ == "__main__":
    RUNTIME.mkdir(exist_ok=True)
    handler = partial(NearfieldHandler, directory=str(DIST))
    server = ThreadingHTTPServer(("127.0.0.1", 4173), handler)
    print("Nearfield available at http://127.0.0.1:4173")
    server.serve_forever()

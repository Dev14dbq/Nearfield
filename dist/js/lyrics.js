/*
  Lyrics: recognised locally from the separated vocal stem (Whisper, via server.py) or loaded
  from the user's own .lrc file. Nothing leaves the machine; results are cached by the server.
*/

const LRC_STORAGE = "nearfield:lrc:";

// [mm:ss.xx] text — several time tags per line are allowed; metadata tags are ignored.
export function parseLrc(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw) => {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) return;
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    tags.forEach(([, min, sec]) => lines.push({ time: Number(min) * 60 + Number(sec.replace(":", ".")), text: body }));
  });
  lines.sort((a, b) => a.time - b.time);
  return lines.map((line, i) => ({ ...line, end: lines[i + 1]?.time ?? line.time + 6 })).filter((line) => line.text);
}

export function fromSegments(segments) {
  return segments.map((segment) => ({ time: segment.start, end: segment.end, text: segment.text, words: segment.words || [] }));
}

export function lineIndexAt(lines, time) {
  let lo = 0; let hi = lines.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function trackKey(track) {
  return `${track.artist}|${track.title}`;
}

export function savedLrc(track) {
  try { return localStorage.getItem(LRC_STORAGE + trackKey(track)); } catch { return null; }
}

export function saveLrc(track, text) {
  try { localStorage.setItem(LRC_STORAGE + trackKey(track), text); } catch { /* storage full or blocked */ }
}

// Asks the local server to transcribe the vocal stem. Resolves with { lines, language }.
export async function transcribe(vocalsPath, onStatus = () => {}, signal) {
  const response = await fetch("/api/lyrics", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: vocalsPath }), signal,
  }).catch(() => null);
  if (!response) throw Object.assign(new Error("Сервер недоступен"), { code: "offline" });
  if (response.status === 404 || response.status === 501) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || "Запусти плеер через python3 server.py"), { code: "offline" });
  }
  let result = await response.json();
  if (response.status === 503) throw Object.assign(new Error(result.error), { code: "missing" });
  if (!response.ok) throw new Error(result.error || "Не удалось распознать текст");
  while (result.state !== "done") {
    if (result.state === "error") throw Object.assign(new Error(result.message), { code: result.message?.includes("pip install") ? "missing" : "error" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    onStatus(result.state === "queued" ? "ТЕКСТ · В ОЧЕРЕДИ" : "ТЕКСТ · WHISPER СЛУШАЕТ ВОКАЛ");
    const job = await fetch(`/api/jobs/${result.jobId ?? result.id}`, { cache: "no-store", signal });
    const next = await job.json();
    result = { ...next, jobId: result.jobId ?? result.id };
  }
  return { lines: fromSegments(result.lyrics.segments || []), language: result.lyrics.language };
}

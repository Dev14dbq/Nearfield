/*
  Lyrics: synced .lrc text from the music service the track came from, or the user's own .lrc file.
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

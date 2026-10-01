/*
  Moods: pick tracks that fit and set the 3D scene to match.
  Tracks are scored on what we know about them: tempo, drive (drums + bass), vocals, detected style
  and the service's genre. The user's library comes first; discoveries from search fill the rest.
*/

import { api } from "./api.js";

const ramp = (x, a, b) => Math.min(1, Math.max(0, (x - a) / (b - a)));
const band = (x, lo, hi, soft) => Math.min(ramp(x, lo - soft, lo), 1 - ramp(x, hi, hi + soft));

export const MOODS = [
  {
    id: "energy", label: "Заряд", sub: "громко и бодро",
    colors: ["#ff7a45", "#ffd23f"],
    tempo: [112, 175], drive: 1, styles: { electronic: 1, rap: 0.8, rock: 0.9, pop: 0.6 },
    genres: ["dance", "electronics", "rock", "rap", "rusrap", "pop", "edm", "house", "metal", "punk"],
    search: ["workout", "energy hits", "бодрая музыка"],
    scene: { mode: "pulse", room: "club", width: 1.15, distance: 1.7, motion: 0.7, roomAmt: 0.8, cue: 0.7, bass: 5, ambience: "none", rate: 1, fxReverb: false },
  },
  {
    id: "chill", label: "Чилл", sub: "никуда не спешить",
    colors: ["#5ee7df", "#3a7bd5"],
    tempo: [70, 108], drive: 0.35, styles: { pop: 0.7, jazz: 0.8, ambient: 0.8, rap: 0.4 },
    genres: ["lounge", "chill", "rnb", "soul", "indie", "jazz", "lofi", "relax"],
    search: ["lofi chill", "chill vibes", "chillhop"],
    scene: { mode: "inside", room: "studio", width: 1.1, distance: 2, motion: 0.35, roomAmt: 1, cue: 0.6, bass: 2, ambience: "none", rate: 1, fxReverb: false },
  },
  {
    id: "sad", label: "Грусть", sub: "slowed + reverb",
    colors: ["#5f6caf", "#1f2a44"],
    tempo: [55, 100], drive: 0.3, styles: { pop: 0.7, ambient: 0.7, rap: 0.4 },
    genres: ["indie", "alternative", "singer-songwriter", "soundtrack", "rnb", "pop"],
    search: ["sad songs", "грустные песни", "slowed reverb"],
    scene: { mode: "orbit", orbitBars: 8, room: "studio", width: 1.2, distance: 2.2, motion: 0.35, roomAmt: 1, cue: 0.6, bass: 4, ambience: "none", rate: 0.85, fxReverb: true, fxAmount: 0.55 },
  },
  {
    id: "focus", label: "Фокус", sub: "без слов и отвлечений",
    colors: ["#a8edea", "#5b8c85"],
    tempo: [60, 125], drive: 0.4, vocals: false, styles: { ambient: 1, classical: 0.9, electronic: 0.6, jazz: 0.6 },
    genres: ["ambient", "classical", "instrumental", "soundtrack", "lofi", "newage", "electronics"],
    search: ["focus music", "deep focus instrumental", "lofi beats"],
    scene: { mode: "stage", room: "studio", width: 1, distance: 2.2, motion: 0.1, roomAmt: 0.9, cue: 0.5, bass: 1, ambience: "none", rate: 1, fxReverb: false },
  },
  {
    id: "party", label: "Вечеринка", sub: "танцпол в голове",
    colors: ["#f857a6", "#7b2ff7"],
    tempo: [118, 135], drive: 1, styles: { electronic: 1, pop: 0.8, rap: 0.7 },
    genres: ["dance", "electronics", "house", "pop", "edm", "techno", "disco"],
    search: ["party hits", "dance hits", "клубные хиты"],
    scene: { mode: "pulse", room: "club", width: 1.1, distance: 1.7, motion: 0.85, roomAmt: 0.9, cue: 0.65, bass: 6, ambience: "none", rate: 1, fxReverb: false },
  },
  {
    id: "night", label: "Ночь", sub: "темно и тихо",
    colors: ["#141e30", "#6a5acd"],
    tempo: [55, 95], drive: 0.25, styles: { ambient: 1, electronic: 0.5, pop: 0.5 },
    genres: ["ambient", "electronics", "triphop", "downtempo", "synthwave", "lounge"],
    search: ["night drive synthwave", "late night vibes", "ambient night"],
    scene: { mode: "dream", room: "studio", width: 1.25, distance: 2.4, motion: 0.45, roomAmt: 1, cue: 0.7, bass: 3, ambience: "none", rate: 1, fxReverb: true, fxAmount: 0.35 },
  },
  {
    id: "love", label: "Романтика", sub: "тепло и близко",
    colors: ["#ff9a9e", "#c94b7c"],
    tempo: [65, 110], drive: 0.45, vocals: true, styles: { pop: 1, jazz: 0.7 },
    genres: ["rnb", "soul", "pop", "jazz", "estrada"],
    search: ["love songs", "romantic rnb", "песни о любви"],
    scene: { mode: "inside", room: "studio", width: 1, distance: 1.2, motion: 0.25, roomAmt: 1, cue: 0.6, bass: 2, ambience: "none", rate: 1, fxReverb: false },
  },
  {
    id: "drive", label: "Дорога", sub: "трасса пустая",
    colors: ["#f7971e", "#e44d26"],
    tempo: [95, 140], drive: 0.8, styles: { rock: 1, electronic: 0.8, pop: 0.7, rap: 0.6 },
    genres: ["rock", "alternative", "indie", "synthwave", "pop", "electronics", "rusrock"],
    search: ["road trip songs", "driving music", "музыка в дорогу"],
    scene: { mode: "stage", room: "club", width: 1.25, distance: 3, motion: 0.3, roomAmt: 0.9, cue: 0.6, bass: 4, ambience: "none", rate: 1, fxReverb: false },
  },
];

export const findMood = (id) => MOODS.find((mood) => mood.id === id) || null;

export function moodScore(mood, track) {
  const a = track.analysis || {};
  const genre = (track.genre || "").toLowerCase();
  let score = 0; let weight = 0;
  if (a.bpm) {
    // Half/double tempo counts too (a 70 bpm ballad is often detected as 140).
    const fit = Math.max(band(a.bpm, mood.tempo[0], mood.tempo[1], 12), 0.7 * band(a.bpm / 2, mood.tempo[0], mood.tempo[1], 12), 0.7 * band(a.bpm * 2, mood.tempo[0], mood.tempo[1], 12));
    score += 1.2 * fit; weight += 1.2;
  }
  if (a.drive != null) { score += 1.1 * (1 - Math.abs(Math.min(1, a.drive * 1.6) - mood.drive)); weight += 1.1; }
  if (a.style) { score += 1.3 * (mood.styles[a.style] ?? 0.15); weight += 1.3; }
  if (mood.vocals != null && a.vocals != null) { score += 0.8 * (a.vocals === mood.vocals ? 1 : 0); weight += 0.8; }
  if (genre) { score += 1 * (mood.genres.some((g) => genre.includes(g)) ? 1 : 0.2); weight += 1; }
  return weight ? score / weight : 0;
}

/** Builds the queue for a mood: best-fitting library tracks, topped up with fresh finds. */
export async function buildMoodQueue(mood, { size = 30 } = {}) {
  const kept = await api.kept().catch(() => []);
  const ranked = kept
    .map((track) => ({ track, score: moodScore(mood, track) }))
    .filter(({ score }) => score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .map(({ track }) => track);
  // Keep variety: the best ones, lightly shuffled within thirds.
  const fromLibrary = ranked.slice(0, Math.round(size * 0.7));
  const shuffledLibrary = fromLibrary.map((track, i) => ({ track, key: i / fromLibrary.length + Math.random() * 0.35 })).sort((a, b) => a.key - b.key).map(({ track }) => track);
  let discoveries = [];
  if (shuffledLibrary.length < size) {
    const query = mood.search[Math.floor(Math.random() * mood.search.length)];
    const result = await api.search(query).catch(() => ({ tracks: [] }));
    const seen = new Set(shuffledLibrary.map((t) => t.id));
    discoveries = result.tracks
      .filter((t) => !seen.has(t.id) && t.sources.some((s) => s.audio === "full"))
      .slice(0, size - shuffledLibrary.length);
  }
  // Interleave: two from the library, one new.
  const queue = [];
  let li = 0; let di = 0;
  while (li < shuffledLibrary.length || di < discoveries.length) {
    if (li < shuffledLibrary.length) queue.push(shuffledLibrary[li++]);
    if (li < shuffledLibrary.length) queue.push(shuffledLibrary[li++]);
    if (di < discoveries.length) queue.push(discoveries[di++]);
  }
  return { queue, fromLibrary: shuffledLibrary.length, discovered: discoveries.length };
}

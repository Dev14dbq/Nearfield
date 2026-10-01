/*
  My Wave: endless recommendations from Yandex Music, built from what the user actually listens to.
  The panel mirrors the service's own settings: activity, character, mood, language.
  Without a Yandex account it falls back to picking from the local library.
*/

import { api } from "./api.js";
import { buildMoodQueue, findMood } from "./moods.js";
import { player } from "./player.js";

export const ACTIVITIES = [
  { id: "wake-up", label: "Просыпаюсь", mood: "chill" },
  { id: "road-trip", label: "В дороге", mood: "drive" },
  { id: "work-background", label: "Работаю", mood: "focus" },
  { id: "workout", label: "Тренируюсь", mood: "energy" },
  { id: "fall-asleep", label: "Засыпаю", mood: "night" },
];

export const CHARACTER = [
  { id: "favorite", label: "Любимое" },
  { id: "discover", label: "Незнакомое" },
  { id: "popular", label: "Популярное" },
];

export const MOOD = [
  { id: "active", label: "Бодрое", colors: ["#ff9a3d", "#e2381f"], mood: "energy" },
  { id: "fun", label: "Весёлое", colors: ["#d9f542", "#5fbf1a"], mood: "party" },
  { id: "calm", label: "Спокойное", colors: ["#3fd6c6", "#1e7fa8"], mood: "chill" },
  { id: "sad", label: "Грустное", colors: ["#5b6cff", "#5a12c9"], mood: "sad" },
];

export const LANGUAGE = [
  { id: "russian", label: "Русское" },
  { id: "not-russian", label: "Иностранное" },
  { id: "without-words", label: "Без слов" },
];

export const DEFAULT_WAVE = { activity: null, diversity: "default", moodEnergy: "all", language: "any" };

export async function loadWave() { return { ...DEFAULT_WAVE, ...(await api.prefGet("wave", {})) }; }
export function saveWave(state) { api.prefSet("wave", state); }

export function describe(state) {
  if (state.activity) return ACTIVITIES.find((a) => a.id === state.activity).label;
  const parts = [
    CHARACTER.find((c) => c.id === state.diversity)?.label,
    MOOD.find((m) => m.id === state.moodEnergy)?.label,
    LANGUAGE.find((l) => l.id === state.language)?.label,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Моя волна";
}

// The scene follows the activity or mood; plain "My Wave" keeps each track's own automatic sound.
function sceneFor(state) {
  const key = state.activity ? ACTIVITIES.find((a) => a.id === state.activity)?.mood : MOOD.find((m) => m.id === state.moodEnergy)?.mood;
  const mood = key && findMood(key);
  return mood ? { label: mood.label, scene: mood.scene } : null;
}

const stationOf = (state) => (state.activity ? `activity:${state.activity}` : "user:onyourwave");
const settingsOf = (state) => (state.activity ? null : { moodEnergy: state.moodEnergy, diversity: state.diversity, language: state.language });

let session = null; // { station, batch, fetching }

export async function startWave(state) {
  saveWave(state);
  const accounts = await api.accounts().catch(() => ({}));
  const scene = sceneFor(state);
  if (!accounts.yandex?.connected) {
    // Offline fallback: the user's own music sorted for the chosen mood.
    const mood = findMood(ACTIVITIES.find((a) => a.id === state.activity)?.mood || MOOD.find((m) => m.id === state.moodEnergy)?.mood || "chill");
    const { queue } = await buildMoodQueue(mood);
    if (!queue.length) throw new Error("Войди в Яндекс Музыку — волна подбирается по тому, что ты слушаешь");
    session = null;
    await player.playList(queue, 0, { type: "wave", id: "local", label: describe(state), scene: scene?.scene });
    return;
  }
  const station = stationOf(state);
  const { tracks, batch } = await api.wave(station, settingsOf(state), null);
  if (!tracks.length) throw new Error("Волна ничего не прислала, попробуй другие настройки");
  session = { station, batch, fetching: false, started: new Set() };
  api.waveFeedback(station, batch, "radioStarted", null, 0).catch(() => {});
  await player.playList(tracks, 0, { type: "wave", id: station, label: describe(state), scene: scene?.scene });
}

const yandexId = (track) => track?.sources?.find((s) => s.provider === "yandex")?.id || null;

// After a restart the queue comes back from the saved session; the wave keeps going from there.
function ensureSession() {
  if (!session && player.context?.type === "wave" && player.context.id !== "local") session = { station: player.context.id, batch: "", fetching: false, started: new Set() };
  return session;
}

async function refill() {
  const wave = ensureSession();
  if (!wave || wave.fetching) return 0;
  wave.fetching = true;
  try {
    // The wave only moves on when it is told what is already queued and what has started playing.
    const recent = player.queue.slice(-20).map(yandexId).filter(Boolean);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { tracks, batch } = await api.wave(wave.station, null, recent.join(","));
      wave.batch = batch;
      const seen = new Set(player.queue.map((t) => t.id));
      const fresh = tracks.filter((t) => !seen.has(t.id));
      if (fresh.length) { player.addToQueue(fresh); return fresh.length; }
      await Promise.all(recent.map((id) => api.waveFeedback(wave.station, batch, "trackStarted", id, 0).catch(() => {})));
    }
    return 0;
  } catch {
    return 0;
  } finally {
    wave.fetching = false;
  }
}

player.on("track", ({ track }) => {
  if (player.context?.type !== "wave") return;
  const wave = ensureSession();
  if (!wave) return;
  wave.started ??= new Set();
  const id = yandexId(track);
  if (id && !wave.started.has(id)) {
    wave.started.add(id);
    api.waveFeedback(wave.station, wave.batch, "trackStarted", id, 0).catch(() => {});
  }
  if (player.index >= player.queue.length - 3) refill();
});

// Reached the end before the next batch arrived: fetch and keep playing.
player.on("moodExhausted", async () => {
  if (player.context?.type !== "wave") return;
  const before = player.queue.length;
  if (await refill()) player.playAt(before);
});

// Feedback makes the next batches better: finished tracks and skips are reported.
player.on("advance", ({ track, played, auto }) => {
  if (player.context?.type !== "wave" || !ensureSession()) return;
  const id = yandexId(track);
  if (id) api.waveFeedback(session.station, session.batch, auto ? "trackFinished" : "skip", id, played).catch(() => {});
});

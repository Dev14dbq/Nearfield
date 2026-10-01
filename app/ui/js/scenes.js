/*
  Sound of a track = scene (where the sound sits) + effects (speed, reverb, atmosphere).
  Automatic: from the detected style, or the active mood. Manual: saved per track.
*/

import { api } from "./api.js";

// Scene per style. Rooms are chosen to suit the music: no stone halls for rap or pop.
export const STYLE_SCENES = {
  pop: { label: "Поп", scene: { mode: "inside", room: "studio", width: 1.1, distance: 1.6, motion: 0.4, roomAmt: 1, cue: 0.65, bass: 2 } },
  rap: { label: "Рэп", scene: { mode: "pulse", room: "studio", width: 1, distance: 1.3, motion: 0.3, roomAmt: 0.6, cue: 0.6, bass: 5 } },
  electronic: { label: "Электро", scene: { mode: "pulse", room: "club", width: 1.2, distance: 1.8, motion: 0.75, roomAmt: 0.8, cue: 0.7, bass: 5 } },
  rock: { label: "Рок", scene: { mode: "stage", room: "club", width: 1.25, distance: 3, motion: 0.2, roomAmt: 0.9, cue: 0.6, bass: 3 } },
  classical: { label: "Классика", scene: { mode: "stage", room: "hall", width: 1.35, distance: 9, motion: 0.05, roomAmt: 1.1, cue: 0.5, bass: 0 } },
  jazz: { label: "Джаз", scene: { mode: "stage", room: "studio", width: 1.1, distance: 2.4, motion: 0.12, roomAmt: 1.2, cue: 0.55, bass: 1 } },
  ambient: { label: "Эмбиент", scene: { mode: "dream", room: "hall", width: 1.3, distance: 2.6, motion: 0.45, roomAmt: 0.9, cue: 0.7, bass: 2 } },
};

// Which rooms make sense for which music. Shown first in the room picker.
export const ROOM_FIT = {
  dry: "любая музыка",
  studio: "поп, рэп, джаз",
  club: "электро, рок",
  hall: "живые инструменты",
  bathroom: "ради шутки",
  cathedral: "классика и хор",
  openair: "рок и электро вживую",
};

export const SCENE_PRESETS = [
  { id: "inside", label: "Внутри", scene: { mode: "inside", room: "studio", width: 1.1, distance: 1.6, motion: 0.45, roomAmt: 1, cue: 0.65, bass: 1 } },
  { id: "stage", label: "Сцена", scene: { mode: "stage", room: "club", width: 1.15, distance: 4, motion: 0.2, roomAmt: 1, cue: 0.55, bass: 3 } },
  { id: "8d", label: "8D", scene: { mode: "orbit", orbitBars: 4, room: "studio", width: 1, distance: 1.7, motion: 0.55, roomAmt: 1.2, cue: 0.75, bass: 2 } },
  { id: "dance", label: "Танцпол", scene: { mode: "pulse", room: "club", width: 1.1, distance: 1.7, motion: 0.8, roomAmt: 0.9, cue: 0.65, bass: 5 } },
  { id: "float", label: "Невесомость", scene: { mode: "dream", room: "hall", width: 1.3, distance: 2.6, motion: 0.6, roomAmt: 0.9, cue: 0.7, bass: 3 } },
  { id: "studio", label: "Студия", scene: { mode: "stage", room: "studio", width: 1, distance: 1.8, motion: 0.1, roomAmt: 0.9, cue: 0.5, bass: 0 } },
];

export const SPEEDS = { slowed: [0.8, 0.85, 0.9], up: [1.1, 1.2, 1.3] };

export const DEFAULT_FX = { rate: 1, fxReverb: false, fxAmount: 0.55, ambience: "none", ambienceLevel: 0.4 };

const SCENE_KEYS = ["mode", "orbitBars", "room", "width", "distance", "motion", "roomAmt", "cue", "bass"];
const FX_KEYS = ["rate", "fxReverb", "fxAmount", "ambience", "ambienceLevel"];
export const SOUND_KEYS = [...SCENE_KEYS, ...FX_KEYS];

/** Genre from the service, used before the track has been analysed. */
export function styleFromGenre(genre = "") {
  const g = genre.toLowerCase();
  if (/rap|hip|trap|drill|grime/.test(g)) return "rap";
  if (/electr|dance|house|techno|edm|trance|dnb|drum|dubstep|synth/.test(g)) return "electronic";
  if (/rock|metal|punk|alternative|grunge|indie/.test(g)) return "rock";
  if (/classic|opera|orchestr|baroque/.test(g)) return "classical";
  if (/jazz|blues|swing|soul/.test(g)) return "jazz";
  if (/ambient|newage|relax|meditat|sleep|lofi|chill/.test(g)) return "ambient";
  return g ? "pop" : null;
}

export function autoSound({ style, mood }) {
  if (mood) return { ...STYLE_SCENES.pop.scene, ...DEFAULT_FX, ...mood.scene };
  return { ...(STYLE_SCENES[style] || STYLE_SCENES.pop).scene, ...DEFAULT_FX };
}

export function pickSound(settings) {
  return Object.fromEntries(SOUND_KEYS.filter((key) => key in settings).map((key) => [key, settings[key]]));
}

export const savedSound = (id) => api.prefGet(`sound:${id}`, null);
export const saveSound = (id, sound) => api.prefSet(`sound:${id}`, sound);
export const forgetSound = (id) => api.prefSet(`sound:${id}`, null);

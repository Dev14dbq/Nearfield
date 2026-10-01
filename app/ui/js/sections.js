/*
  Sections of a track collection (like Yandex Music's chips over "Liked"): language, genre groups,
  mood from the track's own analysis, decades. Only sections that have tracks are shown.
*/

const GENRES = [
  { id: "pop", label: "Поп", codes: ["pop", "ruspop", "estrada", "rusestrada", "europop"] },
  { id: "indie", label: "Инди", codes: ["indie", "local-indie"] },
  { id: "alternative", label: "Альтернатива", codes: ["alternative", "newwave", "postpunk", "shoegaze"] },
  { id: "rock", label: "Рок", codes: ["rock", "rusrock", "punk", "metal", "hardrock", "classicmetal", "numetal", "posthardcore"] },
  { id: "electronic", label: "Электроника", codes: ["electronics", "dance", "house", "techno", "trance", "dnb", "dubstep", "edmgenre", "synthpop"] },
  { id: "rap", label: "Рэп", codes: ["rap", "rusrap", "foreignrap", "hiphop", "trap"] },
  { id: "rnb", label: "R&B и соул", codes: ["rnb", "soul", "funk"] },
  { id: "asia", label: "K-pop и J-pop", codes: ["kpop", "japanesepop", "jpop", "eastern", "anime"] },
  { id: "folk", label: "Фолк и бард", codes: ["folk", "foreignbard", "bard", "country"] },
  { id: "jazz", label: "Джаз", codes: ["jazz", "vocaljazz", "blues"] },
  { id: "soundtrack", label: "Саундтреки", codes: ["soundtrack", "films", "videogame", "tvseries", "musical"] },
  { id: "chillout", label: "Для отдыха", codes: ["relax", "newage", "lounge", "ambient", "meditation", "sleep"] },
  { id: "classical", label: "Классика", codes: ["classical", "modern", "classicalmusic", "opera"] },
];

const CYRILLIC = /[а-яё]/i;
const genreGroup = (genre) => GENRES.find((g) => g.codes.includes((genre || "").toLowerCase()));

// Mood comes from the track's analysis (tempo, drums + bass share, vocals); genre is a fallback.
function energetic(t) {
  const a = t.analysis;
  if (a?.drive != null) return a.drive >= 0.55 || (a.bpm >= 122 && a.drive >= 0.4);
  return ["dance", "punk", "electronics", "rusrap", "rap", "hardrock"].includes(t.genre);
}
function calm(t) {
  const a = t.analysis;
  if (a?.drive != null) return a.drive < 0.38 && (a.bpm <= 100 || a.bpm >= 160);
  return ["relax", "newage", "jazz", "vocaljazz", "classical", "folk", "foreignbard", "lounge", "ambient"].includes(t.genre);
}

export function buildSections(tracks) {
  const defs = [
    { id: "all", label: "Все", test: () => true },
    { id: "ready", label: "Готовы в 3D", icon: "headphones", test: (t) => t.state === "ready" },
    { id: "often", label: "Часто слушаю", icon: "fire", test: (t) => t.plays >= 3 },
    { id: "ru", label: "Русские", icon: "ru", test: (t) => CYRILLIC.test(`${t.title} ${(t.artists || []).map((a) => a.name).join(" ")}`) },
    { id: "foreign", label: "Зарубежные", icon: "globe", test: (t) => !CYRILLIC.test(`${t.title} ${(t.artists || []).map((a) => a.name).join(" ")}`) },
    { id: "energy", label: "Бодрые", icon: "bolt", test: energetic },
    { id: "calm", label: "Спокойные", icon: "leaf", test: calm },
    { id: "instrumental", label: "Без слов", icon: "wave", test: (t) => t.analysis?.vocals === false },
    ...GENRES.map((g) => ({ id: `g:${g.id}`, label: g.label, test: (t) => genreGroup(t.genre)?.id === g.id })),
    { id: "y2020", label: "2020-е", test: (t) => t.year >= 2020 },
    { id: "y2010", label: "2010-е", test: (t) => t.year >= 2010 && t.year < 2020 },
    { id: "y2000", label: "2000-е", test: (t) => t.year >= 2000 && t.year < 2010 },
    { id: "y1990", label: "90-е", test: (t) => t.year >= 1990 && t.year < 2000 },
    { id: "old", label: "До 90-х", icon: "disc", test: (t) => t.year && t.year < 1990 },
  ];
  const total = tracks.length;
  return defs
    .map((d) => ({ ...d, tracks: tracks.filter(d.test) }))
    // Hide empty sections and ones that would just repeat "all" or hold a single stray track.
    .filter((d) => d.id === "all" || (d.tracks.length >= 2 && d.tracks.length < total));
}

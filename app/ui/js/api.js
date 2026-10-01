/* Thin layer over the Rust backend. */

const tauri = window.__TAURI__;

export const invoke = (command, args = {}) => tauri.core.invoke(command, args);
export const fileUrl = (path) => (path ? tauri.core.convertFileSrc(path) : null);
export const listen = (event, handler) => tauri.event.listen(event, (e) => handler(e.payload));

export const api = {
  search: (query) => invoke("search", { query }),
  artist: (id) => invoke("artist", { id }),
  album: (id) => invoke("album", { id }),
  status: (ids) => invoke("library_status", { ids }),
  lyrics: (track) => invoke("lyrics", { track: plain(track) }),
  favorites: () => invoke("favorites"),
  history: () => invoke("history"),
  kept: () => invoke("kept"),
  setFavorite: (track, favorite) => invoke("set_favorite", { track: plain(track), favorite }),
  preparePlay: (track) => invoke("prepare_play", { track: plain(track) }),
  saveAnalysis: (id, analysis) => invoke("save_analysis", { id, analysis }),
  setListening: (listening) => invoke("set_listening", { listening }),
  prepStatus: () => invoke("prep_status"),
  installAi: () => invoke("install_ai"),
  retryFailed: () => invoke("retry_failed"),
  playlists: () => invoke("playlists"),
  playlistTracks: (id) => invoke("playlist_tracks", { id }),
  playlistCreate: (name, tracks) => invoke("playlist_create", { name, tracks: tracks?.map(plain) }),
  playlistRename: (id, name) => invoke("playlist_rename", { id, name }),
  playlistDelete: (id) => invoke("playlist_delete", { id }),
  playlistAdd: (id, track) => invoke("playlist_add", { id, track: plain(track) }),
  playlistRemove: (id, trackId) => invoke("playlist_remove", { id, trackId }),
  playlistReorder: (id, ids) => invoke("playlist_reorder", { id, ids }),
  trackPlaylists: (id) => invoke("track_playlists", { id }),
  accounts: () => invoke("accounts"),
  yandexLogin: () => invoke("yandex_login"),
  importYandexLikes: () => invoke("import_yandex_likes"),
  wave: (station, settings, after) => invoke("wave", { station, settings, after }),
  waveFeedback: (station, batch, kind, track, played) => invoke("wave_feedback", { station, batch, kind, track, played }),
  yandexLogout: () => invoke("yandex_logout"),
  spotifyKeys: (id, secret) => invoke("spotify_keys", { id, secret }),
  prefGet: async (key, fallback = null) => {
    const value = await invoke("pref_get", { key }).catch(() => null);
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  },
  prefSet: (key, value) => invoke("pref_set", { key, value: value == null ? null : JSON.stringify(value) }).catch(() => {}),
};

// Library rows carry local fields (state, files…); the backend only needs the metadata part.
const TRACK_FIELDS = ["id", "title", "artists", "album", "year", "duration", "cover", "genre", "explicit", "isrc", "sources", "popularity"];
export function plain(track) {
  return Object.fromEntries(TRACK_FIELDS.filter((key) => track[key] !== undefined).map((key) => [key, track[key]]));
}

mod db;
mod merge;
mod model;
mod prep;
mod providers;

use db::{Db, LibraryTrack, Playlist};
use model::{ArtistPage, Lyrics, SearchResult, Track};
use providers::Accounts;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    pub db: Mutex<Db>,
    pub http: reqwest::Client,
    pub data_dir: PathBuf,
    pub listening: AtomicBool,
    pub notify: tokio::sync::Notify,
    pub locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub colors: tokio::sync::Mutex<HashMap<String, [u8; 3]>>,
}

impl AppState {
    pub fn accounts(&self) -> Accounts {
        let db = self.db.lock().expect("db");
        Accounts {
            yandex_token: db.setting("yandex_token"),
            spotify_id: db.setting("spotify_id"),
            spotify_secret: db.setting("spotify_secret"),
        }
    }
}

type Res<T> = Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn with_db<T>(state: &AppState, f: impl FnOnce(&Db) -> anyhow::Result<T>) -> Res<T> {
    let db = state.db.lock().map_err(|_| "база занята".to_string())?;
    f(&db).map_err(err)
}

/* ───── discovery ───── */

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Res<SearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    Ok(providers::search(&state.http, &state.accounts(), query).await)
}

#[tauri::command]
async fn artist(state: State<'_, AppState>, id: String) -> Res<ArtistPage> {
    providers::artist_page(&state.http, &state.accounts(), &id).await.map_err(err)
}

#[tauri::command]
async fn album(state: State<'_, AppState>, id: String) -> Res<Vec<Track>> {
    providers::album_tracks(&state.http, &state.accounts(), &id).await.map_err(err)
}

/// Library state (favourite, downloaded, ready…) for tracks shown in search or artist pages.
#[tauri::command]
fn library_status(state: State<'_, AppState>, ids: Vec<String>) -> Res<HashMap<String, LibraryTrack>> {
    with_db(&state, |db| db.many(&ids))
}

#[tauri::command]
async fn lyrics(state: State<'_, AppState>, track: Track) -> Res<Option<Lyrics>> {
    // Cached answers, including "no lyrics", are kept for a week.
    let cached = with_db(&state, |db| db.lyrics(&track.id))?;
    if let Some((lyrics, at)) = cached {
        if lyrics.is_some() || db::now() - at < 7 * 86400 {
            return Ok(lyrics);
        }
    }
    let found = providers::lyrics(&state.http, &state.accounts(), &track).await;
    with_db(&state, |db| {
        db.upsert(&track)?;
        db.set_lyrics(&track.id, found.as_ref())
    })?;
    Ok(found)
}

/// Dominant colour of a cover, computed natively (canvas reads are blocked for cached covers in WebKit).
#[tauri::command]
async fn cover_color(state: State<'_, AppState>, url: String) -> Res<Option<[u8; 3]>> {
    if let Some(color) = state.colors.lock().await.get(&url) {
        return Ok(Some(*color));
    }
    let bytes = state.http.get(&url).send().await.map_err(err)?.bytes().await.map_err(err)?;
    let Ok(img) = image::load_from_memory(&bytes) else { return Ok(None) };
    let small = img.resize_exact(24, 24, image::imageops::FilterType::Triangle).to_rgb8();
    let (mut r, mut g, mut b, mut w) = (0f64, 0f64, 0f64, 0f64);
    // The background continues the cover, so its colour comes from the cover's outer frame.
    for (x, y, p) in small.enumerate_pixels() {
        let edge = x.min(23 - x).min(y.min(23 - y));
        if edge > 3 {
            continue;
        }
        let [pr, pg, pb] = p.0.map(f64::from);
        let weight = (4 - edge) as f64 * (0.6 + (pr.max(pg).max(pb) - pr.min(pg).min(pb)) / 255.0);
        r += pr * weight; g += pg * weight; b += pb * weight; w += weight;
    }
    let color = [(r / w) as u8, (g / w) as u8, (b / w) as u8];
    state.colors.lock().await.insert(url, color);
    Ok(Some(color))
}

/* ───── library ───── */

#[tauri::command]
fn favorites(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.favorites())
}

#[tauri::command]
fn history(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.history(60))
}

#[tauri::command]
fn kept(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.kept())
}

#[tauri::command]
fn set_favorite(app: AppHandle, state: State<'_, AppState>, track: Track, favorite: bool) -> Res<()> {
    with_db(&state, |db| {
        db.upsert(&track)?;
        db.set_favorite(&track.id, favorite)
    })?;
    state.notify.notify_one();
    prep::notify_changed(&app, &track.id);
    Ok(())
}

/// Downloads now if needed and returns local files for playback.
#[tauri::command]
async fn prepare_play(app: AppHandle, track: Track) -> Res<LibraryTrack> {
    let item = prep::ensure_audio(&app, &track).await.map_err(err)?;
    let state = app.state::<AppState>();
    with_db(&state, |db| db.played(&track.id))?;
    Ok(item)
}

#[tauri::command]
fn save_analysis(state: State<'_, AppState>, id: String, analysis: Value) -> Res<()> {
    with_db(&state, |db| db.set_analysis(&id, &analysis))
}

#[tauri::command]
fn set_listening(state: State<'_, AppState>, listening: bool) {
    state.listening.store(listening, Ordering::Relaxed);
    if !listening {
        state.notify.notify_one();
    }
}

#[derive(Serialize)]
struct PrepStatus {
    total: i64,
    ready: i64,
    pending: i64,
    ai: bool,
}

#[tauri::command]
fn prep_status(state: State<'_, AppState>) -> Res<PrepStatus> {
    let (total, ready, pending) = with_db(&state, |db| db.counts())?;
    Ok(PrepStatus { total, ready, pending, ai: prep::python(&state).is_some() })
}

#[tauri::command]
async fn install_ai(app: AppHandle) -> Res<()> {
    prep::install_ai(&app).await.map_err(err)
}

#[tauri::command]
fn retry_failed(state: State<'_, AppState>) -> Res<()> {
    with_db(&state, |db| db.retry_errors())?;
    state.notify.notify_one();
    Ok(())
}

/* ───── playlists ───── */

#[tauri::command]
fn playlists(state: State<'_, AppState>) -> Res<Vec<Playlist>> {
    with_db(&state, |db| db.playlists())
}

#[tauri::command]
fn playlist_tracks(state: State<'_, AppState>, id: i64) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.playlist_tracks(id))
}

#[tauri::command]
fn playlist_create(state: State<'_, AppState>, name: String, tracks: Option<Vec<Track>>) -> Res<i64> {
    let id = with_db(&state, |db| {
        let id = db.create_playlist(name.trim())?;
        for track in tracks.unwrap_or_default() {
            db.upsert(&track)?;
            db.playlist_add(id, &track.id)?;
        }
        Ok(id)
    })?;
    state.notify.notify_one();
    Ok(id)
}

#[tauri::command]
fn playlist_rename(state: State<'_, AppState>, id: i64, name: String) -> Res<()> {
    with_db(&state, |db| db.rename_playlist(id, name.trim()))
}

#[tauri::command]
fn playlist_delete(state: State<'_, AppState>, id: i64) -> Res<()> {
    with_db(&state, |db| db.delete_playlist(id))
}

#[tauri::command]
fn playlist_add(app: AppHandle, state: State<'_, AppState>, id: i64, track: Track) -> Res<()> {
    with_db(&state, |db| {
        db.upsert(&track)?;
        db.playlist_add(id, &track.id)
    })?;
    state.notify.notify_one();
    prep::notify_changed(&app, &track.id);
    Ok(())
}

#[tauri::command]
fn playlist_remove(state: State<'_, AppState>, id: i64, track_id: String) -> Res<()> {
    with_db(&state, |db| db.playlist_remove(id, &track_id))
}

#[tauri::command]
fn playlist_reorder(state: State<'_, AppState>, id: i64, ids: Vec<String>) -> Res<()> {
    with_db(&state, |db| db.playlist_reorder(id, &ids))
}

#[tauri::command]
fn track_playlists(state: State<'_, AppState>, id: String) -> Res<Vec<i64>> {
    with_db(&state, |db| db.track_playlists(&id))
}

/* ───── accounts ───── */

#[tauri::command]
async fn accounts(state: State<'_, AppState>) -> Res<Value> {
    let accounts = state.accounts();
    let yandex = match accounts.yandex_token.as_deref() {
        Some(token) => match providers::yandex::account(&state.http, token).await {
            Ok((login, plus)) => json!({ "connected": true, "login": login, "plus": plus }),
            Err(error) => json!({ "connected": false, "error": error.to_string() }),
        },
        None => json!({ "connected": false }),
    };
    Ok(json!({
        "yandex": yandex,
        "spotify": { "configured": accounts.spotify_id.is_some() && accounts.spotify_secret.is_some() },
        "ai": prep::python(&state).is_some(),
    }))
}

/// Pulls the user's Yandex likes into the favourites; they then download and prepare as usual.
#[tauri::command]
async fn import_yandex_likes(app: AppHandle, state: State<'_, AppState>) -> Res<Value> {
    let token = state.accounts().yandex_token.ok_or("сначала войди в Яндекс Музыку")?;
    let liked = providers::yandex::liked_tracks(&state.http, &token).await.map_err(err)?;
    let total = liked.len();
    let added = with_db(&state, |db| {
        let mut added = 0;
        let fallback = db::now();
        for (i, (track, at)) in liked.iter().enumerate() {
            let known = db.get(&track.id)?.is_some_and(|t| t.favorite);
            db.upsert(track)?;
            // Favourites are ordered by when the track was liked in Yandex (newest on top).
            db.favorite_at(&track.id, at.unwrap_or(fallback - i as i64))?;
            if !known {
                added += 1;
            }
        }
        Ok(added)
    })?;
    state.notify.notify_one();
    let _ = app.emit("library-imported", added);
    Ok(json!({ "added": added, "total": total }))
}

#[tauri::command]
async fn wave(state: State<'_, AppState>, station: String, settings: Option<Value>, after: Option<String>) -> Res<Value> {
    let token = state.accounts().yandex_token.ok_or("нужен вход в Яндекс Музыку")?;
    let (tracks, batch) = providers::yandex::wave(&state.http, &token, &station, settings.as_ref(), after.as_deref()).await.map_err(err)?;
    Ok(json!({ "tracks": tracks, "batch": batch }))
}

#[tauri::command]
async fn wave_feedback(state: State<'_, AppState>, station: String, batch: String, kind: String, track: Option<String>, played: f64) -> Res<()> {
    let Some(token) = state.accounts().yandex_token else { return Ok(()) };
    providers::yandex::wave_feedback(&state.http, &token, &station, &batch, &kind, track.as_deref(), played).await.map_err(err)
}

/// Opens Yandex's own sign-in page; the token comes back in the redirect and never passes through us otherwise.
#[tauri::command]
async fn yandex_login(app: AppHandle) -> Res<()> {
    if let Some(window) = app.get_webview_window("yandex-login") {
        let _ = window.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let url = providers::yandex::oauth_url().parse().map_err(err)?;
    WebviewWindowBuilder::new(&app, "yandex-login", WebviewUrl::External(url))
        .title("Вход в Яндекс Музыку")
        .inner_size(480.0, 720.0)
        .on_navigation(move |url| {
            let fragment = url.fragment().unwrap_or("");
            let token = fragment
                .split('&')
                .find_map(|pair| pair.strip_prefix("access_token="))
                .map(str::to_string);
            match token {
                Some(token) => {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<AppState>();
                        if let Ok(db) = state.db.lock() {
                            let _ = db.set_setting("yandex_token", Some(&token));
                            // Tracks that were only previews can now be fetched in full.
                            let _ = db.reset_previews();
                            let _ = db.retry_errors();
                        }
                        state.notify.notify_one();
                        let _ = handle.emit("accounts-changed", ());
                        let _ = handle.emit("yandex-signed-in", ());
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        if let Some(window) = handle.get_webview_window("yandex-login") {
                            let _ = window.close();
                        }
                    });
                    false
                }
                None => true,
            }
        })
        .build()
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn yandex_logout(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    with_db(&state, |db| db.set_setting("yandex_token", None))?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
fn spotify_keys(app: AppHandle, state: State<'_, AppState>, id: String, secret: String) -> Res<()> {
    let (id, secret) = (id.trim().to_string(), secret.trim().to_string());
    with_db(&state, |db| {
        db.set_setting("spotify_id", Some(&id).filter(|s| !s.is_empty()).map(|s| s.as_str()))?;
        db.set_setting("spotify_secret", Some(&secret).filter(|s| !s.is_empty()).map(|s| s.as_str()))
    })?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Small key-value store for UI preferences (scene settings, last mood…).
#[tauri::command]
fn pref_get(state: State<'_, AppState>, key: String) -> Res<Option<String>> {
    with_db(&state, |db| Ok(db.setting(&format!("ui:{key}"))))
}

#[tauri::command]
fn pref_set(state: State<'_, AppState>, key: String, value: Option<String>) -> Res<()> {
    with_db(&state, |db| db.set_setting(&format!("ui:{key}"), value.as_deref()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("tracks"))?;
            let db = Db::open(&data_dir.join("library.sqlite"))?;
            db.reset_interrupted()?;
            let http = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(300))
                .gzip(true)
                .build()?;
            app.manage(AppState {
                db: Mutex::new(db),
                http,
                data_dir,
                listening: AtomicBool::new(false),
                notify: tokio::sync::Notify::new(),
                locks: tokio::sync::Mutex::new(HashMap::new()),
                colors: tokio::sync::Mutex::new(HashMap::new()),
            });
            prep::spawn_worker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            cover_color,
            artist,
            album,
            library_status,
            lyrics,
            favorites,
            history,
            kept,
            set_favorite,
            prepare_play,
            save_analysis,
            set_listening,
            prep_status,
            retry_failed,
            install_ai,
            playlists,
            playlist_tracks,
            playlist_create,
            playlist_rename,
            playlist_delete,
            playlist_add,
            playlist_remove,
            playlist_reorder,
            track_playlists,
            accounts,
            yandex_login,
            import_yandex_likes,
            wave,
            wave_feedback,
            yandex_logout,
            spotify_keys,
            pref_get,
            pref_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nearfield");
}

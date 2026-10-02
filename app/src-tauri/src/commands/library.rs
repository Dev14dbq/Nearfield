//! The user's library: favourites, history, playback preparation, preferences.

use crate::db::LibraryTrack;
use crate::model::Track;
use crate::{err, media, prep, with_db, AppState, Res};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct PrepStatus {
    total: i64,
    ready: i64,
    pending: i64,
    ai: bool,
}

#[tauri::command]
pub fn favorites(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.favorites())
}

#[tauri::command]
pub fn history(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.history(60))
}

#[tauri::command]
pub fn kept(state: State<'_, AppState>) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.kept())
}

#[tauri::command]
pub fn set_favorite(app: AppHandle, state: State<'_, AppState>, track: Track, favorite: bool) -> Res<()> {
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
pub async fn prepare_play(app: AppHandle, track: Track) -> Res<LibraryTrack> {
    let item = prep::ensure_audio(&app, &track).await.map_err(err)?;
    let state = app.state::<AppState>();
    with_db(&state, |db| db.played(&track.id))?;
    Ok(item)
}

#[tauri::command]
pub fn save_analysis(state: State<'_, AppState>, id: String, analysis: Value) -> Res<()> {
    with_db(&state, |db| db.set_analysis(&id, &analysis))
}

/// Pushes what is playing to the system (Now Playing, media keys, lock screen).
#[tauri::command]
pub fn media_update(media: State<'_, media::Media>, info: media::Info) {
    media.update(&info);
}

#[tauri::command]
pub fn set_listening(state: State<'_, AppState>, listening: bool) {
    state.listening.store(listening, Ordering::Relaxed);
    if !listening {
        state.notify.notify_one();
    }
}

#[tauri::command]
pub fn prep_status(state: State<'_, AppState>) -> Res<PrepStatus> {
    let (total, ready, pending) = with_db(&state, |db| db.counts())?;
    Ok(PrepStatus { total, ready, pending, ai: prep::python(&state).is_some() })
}

#[tauri::command]
pub async fn install_ai(app: AppHandle) -> Res<()> {
    prep::install_ai(&app).await.map_err(err)
}

#[tauri::command]
pub fn retry_failed(state: State<'_, AppState>) -> Res<()> {
    with_db(&state, |db| db.retry_errors())?;
    state.notify.notify_one();
    Ok(())
}

/// Small key-value store for UI preferences (scene settings, last mood…).
#[tauri::command]
pub fn pref_get(state: State<'_, AppState>, key: String) -> Res<Option<String>> {
    with_db(&state, |db| Ok(db.setting(&format!("ui:{key}"))))
}

#[tauri::command]
pub fn pref_set(state: State<'_, AppState>, key: String, value: Option<String>) -> Res<()> {
    with_db(&state, |db| db.set_setting(&format!("ui:{key}"), value.as_deref()))
}

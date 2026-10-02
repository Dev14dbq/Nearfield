//! Playlists.

use crate::db::{LibraryTrack, Playlist};
use crate::model::Track;
use crate::{prep, with_db, AppState, Res};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn playlists(state: State<'_, AppState>) -> Res<Vec<Playlist>> {
    with_db(&state, |db| db.playlists())
}

#[tauri::command]
pub fn playlist_tracks(state: State<'_, AppState>, id: i64) -> Res<Vec<LibraryTrack>> {
    with_db(&state, |db| db.playlist_tracks(id))
}

#[tauri::command]
pub fn playlist_create(state: State<'_, AppState>, name: String, tracks: Option<Vec<Track>>) -> Res<i64> {
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
pub fn playlist_rename(state: State<'_, AppState>, id: i64, name: String) -> Res<()> {
    with_db(&state, |db| db.rename_playlist(id, name.trim()))
}

#[tauri::command]
pub fn playlist_delete(state: State<'_, AppState>, id: i64) -> Res<()> {
    with_db(&state, |db| db.delete_playlist(id))
}

#[tauri::command]
pub fn playlist_add(app: AppHandle, state: State<'_, AppState>, id: i64, track: Track) -> Res<()> {
    with_db(&state, |db| {
        db.upsert(&track)?;
        db.playlist_add(id, &track.id)
    })?;
    state.notify.notify_one();
    prep::notify_changed(&app, &track.id);
    Ok(())
}

#[tauri::command]
pub fn playlist_remove(state: State<'_, AppState>, id: i64, track_id: String) -> Res<()> {
    with_db(&state, |db| db.playlist_remove(id, &track_id))
}

#[tauri::command]
pub fn playlist_reorder(state: State<'_, AppState>, id: i64, ids: Vec<String>) -> Res<()> {
    with_db(&state, |db| db.playlist_reorder(id, &ids))
}

#[tauri::command]
pub fn track_playlists(state: State<'_, AppState>, id: String) -> Res<Vec<i64>> {
    with_db(&state, |db| db.track_playlists(&id))
}

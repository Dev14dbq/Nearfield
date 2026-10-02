//! Finding music: search, artists, albums, lyrics, cover colours, My Wave.

use crate::db::{self, LibraryTrack};
use crate::model::{ArtistPage, Lyrics, SearchResult, Track};
use crate::{err, providers, with_db, AppState, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Res<SearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    Ok(providers::search(&state.http, &state.accounts(), query).await)
}

#[tauri::command]
pub async fn artist(state: State<'_, AppState>, id: String) -> Res<ArtistPage> {
    providers::artist_page(&state.http, &state.accounts(), &id).await.map_err(err)
}

#[tauri::command]
pub async fn album(state: State<'_, AppState>, id: String) -> Res<Vec<Track>> {
    providers::album_tracks(&state.http, &state.accounts(), &id).await.map_err(err)
}

/// Library state (favourite, downloaded, ready…) for tracks shown in search or artist pages.
#[tauri::command]
pub fn library_status(state: State<'_, AppState>, ids: Vec<String>) -> Res<HashMap<String, LibraryTrack>> {
    with_db(&state, |db| db.many(&ids))
}

#[tauri::command]
pub async fn lyrics(state: State<'_, AppState>, track: Track) -> Res<Option<Lyrics>> {
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
pub async fn cover_color(state: State<'_, AppState>, url: String) -> Res<Option<[u8; 3]>> {
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

#[tauri::command]
pub async fn wave(state: State<'_, AppState>, station: String, settings: Option<Value>, after: Option<String>) -> Res<Value> {
    let token = state.accounts().yandex_token.ok_or("нужен вход в Яндекс Музыку")?;
    let (tracks, batch) = providers::yandex::wave(&state.http, &token, &station, settings.as_ref(), after.as_deref()).await.map_err(err)?;
    Ok(json!({ "tracks": tracks, "batch": batch }))
}

#[tauri::command]
pub async fn wave_feedback(state: State<'_, AppState>, station: String, batch: String, kind: String, track: Option<String>, played: f64) -> Res<()> {
    let Some(token) = state.accounts().yandex_token else { return Ok(()) };
    providers::yandex::wave_feedback(&state.http, &token, &station, &batch, &kind, track.as_deref(), played).await.map_err(err)
}

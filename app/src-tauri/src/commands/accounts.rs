//! Service accounts: Yandex sign-in and likes import, Spotify keys.

use crate::db;
use crate::{err, prep, providers, with_db, AppState, Res};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub async fn accounts(state: State<'_, AppState>) -> Res<Value> {
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
pub async fn import_yandex_likes(app: AppHandle, state: State<'_, AppState>) -> Res<Value> {
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

/// Opens Yandex's own sign-in page; the token comes back in the redirect and never passes through us otherwise.
#[tauri::command]
pub async fn yandex_login(app: AppHandle) -> Res<()> {
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
pub fn yandex_logout(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    with_db(&state, |db| db.set_setting("yandex_token", None))?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
pub fn spotify_keys(app: AppHandle, state: State<'_, AppState>, id: String, secret: String) -> Res<()> {
    let (id, secret) = (id.trim().to_string(), secret.trim().to_string());
    with_db(&state, |db| {
        db.set_setting("spotify_id", Some(&id).filter(|s| !s.is_empty()).map(|s| s.as_str()))?;
        db.set_setting("spotify_secret", Some(&secret).filter(|s| !s.is_empty()).map(|s| s.as_str()))
    })?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

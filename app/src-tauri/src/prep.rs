//! Getting tracks ready for 3D: download the audio, then split it into stems with Demucs.
//! Kept tracks (favourites, playlists) are prepared in the background; heavy separation
//! only runs while nothing is playing so it never competes with listening.

use crate::db::{state, LibraryTrack};
use crate::merge::short_hash;
use crate::model::Track;
use crate::providers::{self, soundcloud, yandex};
use crate::AppState;
use anyhow::{anyhow, bail, Context, Result};
use futures::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

pub const STEMS: [&str; 4] = ["vocals", "bass", "drums", "other"];

pub fn track_dir(app: &AppState, id: &str) -> PathBuf {
    app.data_dir.join("tracks").join(short_hash(id))
}

pub fn notify_changed(handle: &AppHandle, id: &str) {
    let state = handle.state::<AppState>();
    let track = state.db.lock().ok().and_then(|db| db.get(id).ok().flatten());
    let _ = handle.emit("track-changed", json!({ "id": id, "track": track }));
}

/// One lock per track so the background worker and "play now" never download the same file twice.
async fn track_lock(app: &AppState, id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = app.locks.lock().await;
    locks.entry(id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

async fn fetch_to(http: &reqwest::Client, urls: &[String], target: &Path) -> Result<()> {
    let partial = target.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await?;
    for url in urls {
        let response = http.get(url).send().await?.error_for_status()?;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            file.write_all(&chunk?).await?;
        }
    }
    file.flush().await?;
    drop(file);
    if tokio::fs::metadata(&partial).await?.len() < 50_000 {
        let _ = tokio::fs::remove_file(&partial).await;
        bail!("сервис отдал пустой файл");
    }
    tokio::fs::rename(&partial, target).await?;
    Ok(())
}

/// When the track came only from a metadata service (Spotify), find it where audio is available.
async fn find_audio_sources(app: &AppState, track: &mut Track) {
    if track.sources.iter().any(|s| s.audio == "full") {
        return;
    }
    let accounts = app.accounts();
    let query = format!("{} {}", track.artists.first().map(|a| a.name.as_str()).unwrap_or(""), track.title);
    let found = providers::search(&app.http, &accounts, &query).await;
    if let Some(same) = found.tracks.into_iter().find(|t| t.id == track.id) {
        crate::merge::absorb(track, same);
    }
}

/// Downloads the best available audio. Returns (path, is_preview).
async fn download(app: &AppState, mut track: Track) -> Result<(PathBuf, bool)> {
    find_audio_sources(app, &mut track).await;
    if let Ok(db) = app.db.lock() {
        let _ = db.upsert(&track);
    }
    let dir = track_dir(app, &track.id);
    tokio::fs::create_dir_all(&dir).await?;
    let target = dir.join("audio.mp3");
    let token = app.accounts().yandex_token;
    let mut errors = Vec::new();
    let mut ordered: Vec<_> = track.sources.iter().filter(|s| s.audio != "none").collect();
    // Full tracks first; Yandex (studio masters) before SoundCloud uploads.
    ordered.sort_by_key(|s| (s.audio != "full", s.provider != "yandex"));
    for source in ordered {
        let attempt = async {
            match source.provider.as_str() {
                "yandex" => {
                    let url = yandex::audio_url(&app.http, token.as_deref(), &source.id).await?;
                    fetch_to(&app.http, &[url], &target).await
                }
                "soundcloud" => match soundcloud::stream(&app.http, &source.id).await? {
                    soundcloud::Stream::File(url) => fetch_to(&app.http, &[url], &target).await,
                    soundcloud::Stream::Segments(urls) => fetch_to(&app.http, &urls, &target).await,
                },
                _ => Err(anyhow!("нет аудио")),
            }
        };
        match attempt.await {
            Ok(()) => return Ok((target, source.audio != "full")),
            Err(error) => errors.push(format!("{}: {error}", source.provider)),
        }
    }
    if errors.is_empty() {
        bail!("трек нигде не доступен для прослушивания")
    }
    bail!("{}", errors.join("; "))
}

pub fn python(app: &AppState) -> Option<PathBuf> {
    let configured = app.db.lock().ok().and_then(|db| db.setting("python")).map(PathBuf::from);
    let candidates = [
        configured,
        Some(app.data_dir.join("ai").join("bin").join("python")),
        // Development build: the project's own environment.
        Some(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.venv/bin/python"))),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
}

async fn separate(app: &AppState, audio: &Path) -> Result<HashMap<String, String>> {
    let python = python(app).ok_or_else(|| anyhow!("AI-разделение не установлено"))?;
    let dir = audio.parent().context("нет папки трека")?;
    let work = dir.join("demucs");
    let _ = tokio::fs::remove_dir_all(&work).await;
    let device = if cfg!(target_os = "macos") { "mps" } else { "cpu" };
    let mut command = tokio::process::Command::new("nice");
    command
        .args(["-n", "12"])
        .arg(&python)
        .args(["-m", "demucs", "-n", "htdemucs", "-d", device, "--mp3", "--mp3-bitrate", "192", "--mp3-preset", "4", "-o"])
        .arg(&work)
        .arg(audio)
        .kill_on_drop(true);
    let output = command.output().await.context("не удалось запустить Demucs")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
        bail!("Demucs: {}", tail.trim());
    }
    let mut stems = HashMap::new();
    for stem in STEMS {
        let found = find_file(&work, &format!("{stem}.mp3")).ok_or_else(|| anyhow!("Demucs не создал {stem}"))?;
        let target = dir.join(format!("{stem}.mp3"));
        tokio::fs::rename(&found, &target).await?;
        stems.insert(stem.to_string(), target.to_string_lossy().into_owned());
    }
    let _ = tokio::fs::remove_dir_all(&work).await;
    Ok(stems)
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }
    }
    None
}

/// Makes sure the track's audio is on disk, downloading right now if needed.
pub async fn ensure_audio(handle: &AppHandle, track: &Track) -> Result<LibraryTrack> {
    let app = handle.state::<AppState>();
    {
        let db = app.db.lock().map_err(|_| anyhow!("база занята"))?;
        db.upsert(track)?;
    }
    let lock = track_lock(&app, &track.id).await;
    let _guard = lock.lock().await;
    let current = app.db.lock().map_err(|_| anyhow!("база занята"))?.get(&track.id)?.context("трек пропал")?;
    if current.audio.as_deref().is_some_and(|p| Path::new(p).exists()) {
        return Ok(current);
    }
    app.db.lock().map_err(|_| anyhow!("база занята"))?.set_state(&track.id, state::DOWNLOADING, None)?;
    notify_changed(handle, &track.id);
    let result = download(&app, current.track.clone()).await;
    {
        let db = app.db.lock().map_err(|_| anyhow!("база занята"))?;
        match &result {
            Ok((path, preview)) => db.set_audio(&track.id, &path.to_string_lossy(), *preview)?,
            Err(error) => db.set_state(&track.id, state::ERROR, Some(&error.to_string()))?,
        }
    }
    notify_changed(handle, &track.id);
    result?;
    app.notify.notify_one();
    let item = app.db.lock().map_err(|_| anyhow!("база занята"))?.get(&track.id)?.context("трек пропал")?;
    Ok(item)
}

async fn separate_track(handle: &AppHandle, item: &LibraryTrack) -> Result<()> {
    let app = handle.state::<AppState>();
    let lock = track_lock(&app, &item.track.id).await;
    let _guard = lock.lock().await;
    let audio = item.audio.clone().context("нет аудио")?;
    app.db.lock().map_err(|_| anyhow!("база занята"))?.set_state(&item.track.id, state::SEPARATING, None)?;
    notify_changed(handle, &item.track.id);
    let result = separate(&app, Path::new(&audio)).await;
    {
        let db = app.db.lock().map_err(|_| anyhow!("база занята"))?;
        match &result {
            Ok(stems) => db.set_stems(&item.track.id, stems)?,
            Err(error) => db.set_state(&item.track.id, state::ERROR, Some(&error.to_string()))?,
        }
    }
    notify_changed(handle, &item.track.id);
    result.map(|_| ())
}

pub fn spawn_worker(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let app = handle.state::<AppState>();
            let can_separate = !app.listening.load(Ordering::Relaxed) && python(&app).is_some();
            let next = app.db.lock().ok().and_then(|db| db.next_to_prepare(can_separate).ok().flatten());
            match next {
                Some(item) if item.audio.is_none() => {
                    let _ = ensure_audio(&handle, &item.track).await;
                }
                Some(item) => {
                    let _ = separate_track(&handle, &item).await;
                }
                None => {
                    let _ = tokio::time::timeout(Duration::from_secs(30), app.notify.notified()).await;
                }
            }
            let _ = handle.emit("prep-progress", ());
        }
    });
}

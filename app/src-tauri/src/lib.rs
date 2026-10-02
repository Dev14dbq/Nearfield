mod commands;
mod db;
mod media;
mod merge;
mod model;
mod prep;
mod providers;

use db::Db;
use providers::Accounts;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

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
            app.manage(media::Media::start(app.handle()));
            prep::spawn_worker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::discover::search,
            commands::discover::artist,
            commands::discover::album,
            commands::discover::library_status,
            commands::discover::lyrics,
            commands::discover::cover_color,
            commands::discover::wave,
            commands::discover::wave_feedback,
            commands::library::favorites,
            commands::library::history,
            commands::library::kept,
            commands::library::set_favorite,
            commands::library::prepare_play,
            commands::library::save_analysis,
            commands::library::media_update,
            commands::library::set_listening,
            commands::library::prep_status,
            commands::library::install_ai,
            commands::library::retry_failed,
            commands::library::pref_get,
            commands::library::pref_set,
            commands::playlists::playlists,
            commands::playlists::playlist_tracks,
            commands::playlists::playlist_create,
            commands::playlists::playlist_rename,
            commands::playlists::playlist_delete,
            commands::playlists::playlist_add,
            commands::playlists::playlist_remove,
            commands::playlists::playlist_reorder,
            commands::playlists::track_playlists,
            commands::accounts::accounts,
            commands::accounts::import_yandex_likes,
            commands::accounts::yandex_login,
            commands::accounts::yandex_logout,
            commands::accounts::spotify_keys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nearfield");
}

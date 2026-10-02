//! System media integration: the Now Playing widget, keyboard media keys, headphone buttons,
//! and other apps' play / pause / next / previous / seek (macOS, Windows SMTC, Linux MPRIS).

use serde_json::json;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub struct Media(Mutex<Option<MediaControls>>);

impl Media {
    pub fn start(app: &AppHandle) -> Self {
        #[cfg(windows)]
        let hwnd = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as *mut std::ffi::c_void);
        #[cfg(not(windows))]
        let hwnd = None;
        let config = PlatformConfig { display_name: "Nearfield", dbus_name: "nearfield", hwnd };
        let controls = MediaControls::new(config).ok().and_then(|mut controls| {
            let handle = app.clone();
            controls
                .attach(move |event| {
                    let payload = match event {
                        MediaControlEvent::Play => json!({ "action": "play" }),
                        MediaControlEvent::Pause => json!({ "action": "pause" }),
                        MediaControlEvent::Toggle => json!({ "action": "toggle" }),
                        MediaControlEvent::Next => json!({ "action": "next" }),
                        MediaControlEvent::Previous => json!({ "action": "previous" }),
                        MediaControlEvent::Stop => json!({ "action": "pause" }),
                        MediaControlEvent::Seek(dir) => json!({ "action": "seekBy", "seconds": if dir == SeekDirection::Forward { 10 } else { -10 } }),
                        MediaControlEvent::SeekBy(dir, by) => json!({ "action": "seekBy", "seconds": by.as_secs_f64() * if dir == SeekDirection::Forward { 1.0 } else { -1.0 } }),
                        MediaControlEvent::SetPosition(MediaPosition(at)) => json!({ "action": "seekTo", "seconds": at.as_secs_f64() }),
                        MediaControlEvent::Raise => {
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            return;
                        }
                        _ => return,
                    };
                    let _ = handle.emit("media-key", payload);
                })
                .ok()?;
            Some(controls)
        });
        Self(Mutex::new(controls))
    }

    pub fn update(&self, info: &Info) {
        let Ok(mut guard) = self.0.lock() else { return };
        let Some(controls) = guard.as_mut() else { return };
        if let Some(track) = &info.track {
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(&track.title),
                artist: Some(&track.artist),
                album: track.album.as_deref(),
                cover_url: track.cover.as_deref(),
                duration: Some(Duration::from_secs_f64(track.duration.max(0.0))),
            });
        }
        let progress = Some(MediaPosition(Duration::from_secs_f64(info.position.max(0.0))));
        let _ = controls.set_playback(if info.track.is_none() {
            MediaPlayback::Stopped
        } else if info.playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        });
    }
}

#[derive(serde::Deserialize)]
pub struct TrackInfo {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration: f64,
}

#[derive(serde::Deserialize)]
pub struct Info {
    pub track: Option<TrackInfo>,
    pub playing: bool,
    pub position: f64,
}

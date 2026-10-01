//! SoundCloud through its public web API (the same one soundcloud.com uses).

use crate::merge::track_key;
use crate::model::{Artist, ArtistPage, ArtistRef, Link, Source, Track};
use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;
use tokio::sync::RwLock;

const API: &str = "https://api-v2.soundcloud.com";

static CLIENT_ID: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn client_cell() -> &'static RwLock<Option<String>> {
    CLIENT_ID.get_or_init(|| RwLock::new(None))
}

/// The web client id rotates; it is read from soundcloud.com's own scripts and cached.
async fn client_id(http: &reqwest::Client, refresh: bool) -> Result<String> {
    if !refresh {
        if let Some(id) = client_cell().read().await.clone() {
            return Ok(id);
        }
    }
    let page = http.get("https://soundcloud.com/").send().await?.text().await?;
    let script_re = Regex::new(r#"https://a-v2\.sndcdn\.com/assets/[^"]+\.js"#)?;
    let id_re = Regex::new(r#"client_id\s*:\s*"([A-Za-z0-9]{20,40})""#)?;
    let scripts: Vec<String> = script_re.find_iter(&page).map(|m| m.as_str().to_string()).collect();
    for script in scripts.iter().rev() {
        let body = http.get(script).send().await?.text().await?;
        if let Some(found) = id_re.captures(&body) {
            let id = found[1].to_string();
            *client_cell().write().await = Some(id.clone());
            return Ok(id);
        }
    }
    bail!("SoundCloud: не удалось подключиться")
}

async fn get(http: &reqwest::Client, path_or_url: &str, query: &[(&str, String)]) -> Result<Value> {
    let url = if path_or_url.starts_with("http") { path_or_url.to_string() } else { format!("{API}{path_or_url}") };
    for attempt in 0..2 {
        let id = client_id(http, attempt > 0).await?;
        let response = http.get(&url).query(query).query(&[("client_id", id)]).send().await.context("SoundCloud недоступен")?;
        if response.status() == 401 || response.status() == 403 {
            continue;
        }
        if !response.status().is_success() {
            bail!("SoundCloud: {}", response.status());
        }
        return Ok(response.json().await?);
    }
    bail!("SoundCloud отказал в доступе")
}

fn artwork(url: Option<&str>) -> Option<String> {
    url.filter(|u| !u.is_empty()).map(|u| u.replace("-large.", "-t500x500."))
}

fn junk() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:free download|free dl|out now)\b").unwrap())
}

pub fn parse_track(t: &Value) -> Option<Track> {
    if t.get("kind").and_then(Value::as_str).is_some_and(|k| k != "track") {
        return None;
    }
    let id = t.get("id")?.as_i64()?.to_string();
    let raw_title = t.get("title")?.as_str()?.trim().to_string();
    let user = t.get("user");
    let uploader = user.and_then(|u| u.get("username")).and_then(Value::as_str).unwrap_or("").to_string();
    let user_id = user.and_then(|u| u.get("id")).and_then(Value::as_i64).map(|id| format!("soundcloud:{id}"));
    let meta_artist = t
        .pointer("/publisher_metadata/artist")
        .and_then(Value::as_str)
        .filter(|a| !a.trim().is_empty())
        .map(str::to_string);
    // Most uploads are titled "Artist - Title".
    let (artist, title) = match (meta_artist, raw_title.split_once(" - ")) {
        (Some(a), Some((left, right))) if left.trim().eq_ignore_ascii_case(a.trim()) => (a, right.trim().to_string()),
        (Some(a), _) => (a, raw_title.clone()),
        (None, Some((left, right))) => (left.trim().to_string(), right.trim().to_string()),
        (None, None) => (uploader.clone(), raw_title.clone()),
    };
    let title = junk().replace_all(&title, "").trim().trim_matches(|c| c == '|' || c == '-').trim().to_string();
    let snipped = t.get("policy").and_then(Value::as_str) == Some("SNIP")
        || t.pointer("/media/transcodings")
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty() && list.iter().all(|x| x.get("snipped").and_then(Value::as_bool).unwrap_or(false)));
    let streamable = t.get("streamable").and_then(Value::as_bool).unwrap_or(true);
    let artist_id = if artist.eq_ignore_ascii_case(&uploader) { user_id } else { None };
    Some(Track {
        id: track_key(&artist, &title),
        title,
        artists: vec![ArtistRef { name: artist, id: artist_id }],
        album: t.pointer("/publisher_metadata/album_title").and_then(Value::as_str).map(str::to_string),
        year: t
            .get("release_date")
            .or_else(|| t.get("created_at"))
            .and_then(Value::as_str)
            .and_then(|d| d.get(..4)?.parse().ok()),
        duration: t.get("full_duration").or_else(|| t.get("duration")).and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
        cover: artwork(t.get("artwork_url").and_then(Value::as_str))
            .or_else(|| artwork(user.and_then(|u| u.get("avatar_url")).and_then(Value::as_str))),
        genre: t.get("genre").and_then(Value::as_str).filter(|g| !g.is_empty()).map(str::to_string),
        explicit: t.pointer("/publisher_metadata/explicit").and_then(Value::as_bool).unwrap_or(false),
        isrc: t.pointer("/publisher_metadata/isrc").and_then(Value::as_str).map(str::to_string),
        sources: vec![Source {
            provider: "soundcloud".into(),
            id,
            audio: if !streamable { "none" } else if snipped { "preview" } else { "full" }.into(),
            url: t.get("permalink_url").and_then(Value::as_str).map(str::to_string),
        }],
        popularity: t.get("playback_count").and_then(Value::as_f64),
    })
}

fn parse_user(u: &Value) -> Option<Artist> {
    let id = u.get("id")?.as_i64()?.to_string();
    Some(Artist {
        id: format!("soundcloud:{id}"),
        name: u.get("username")?.as_str()?.to_string(),
        image: artwork(u.get("avatar_url").and_then(Value::as_str)),
        genres: vec![],
        followers: u.get("followers_count").and_then(Value::as_i64),
        sources: vec![Source {
            provider: "soundcloud".into(),
            id,
            audio: "none".into(),
            url: u.get("permalink_url").and_then(Value::as_str).map(str::to_string),
        }],
    })
}

pub async fn search(http: &reqwest::Client, query: &str) -> Result<(Vec<Track>, Vec<Artist>)> {
    let track_query = [("q", query.to_string()), ("limit", "30".to_string())];
    let user_query = [("q", query.to_string()), ("limit", "6".to_string())];
    let (tracks, users) = tokio::join!(get(http, "/search/tracks", &track_query), get(http, "/search/users", &user_query));
    let tracks: Vec<Track> = tracks?
        .get("collection")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_track).collect())
        .unwrap_or_default();
    let users = users
        .ok()
        .and_then(|u| u.get("collection").and_then(Value::as_array).cloned())
        .map(|list| {
            list.iter()
                .filter_map(parse_user)
                // Only real artists, not every random account with that word.
                .filter(|a| a.followers.unwrap_or(0) >= 5000)
                .collect()
        })
        .unwrap_or_default();
    Ok((tracks, users))
}

pub async fn artist_page(http: &reqwest::Client, id: &str) -> Result<ArtistPage> {
    let (user_path, top_path) = (format!("/users/{id}"), format!("/users/{id}/toptracks"));
    let top_query = [("limit", "20".to_string())];
    let (user, top) = tokio::join!(get(http, &user_path, &[]), get(http, &top_path, &top_query));
    let user = user?;
    let artist = parse_user(&user).ok_or_else(|| anyhow!("артист не найден"))?;
    let tracks = top
        .ok()
        .and_then(|t| t.get("collection").and_then(Value::as_array).cloned())
        .map(|list| list.iter().filter_map(parse_track).collect())
        .unwrap_or_default();
    let mut links = Vec::new();
    if let Some(url) = user.get("permalink_url").and_then(Value::as_str) {
        links.push(Link { title: "SoundCloud".into(), url: url.into() });
    }
    Ok(ArtistPage {
        description: user.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string),
        listeners: None,
        likes: user.get("followers_count").and_then(Value::as_i64),
        images: user
            .pointer("/visuals/visuals")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(|x| x.get("visual_url").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default(),
        tracks,
        albums: vec![],
        similar: vec![],
        links,
        providers: vec!["soundcloud".into()],
        artist,
    })
}

pub enum Stream {
    /// One file (progressive MP3).
    File(String),
    /// HLS playlist of MP3 segments; concatenated they form a valid MP3.
    Segments(Vec<String>),
}

pub async fn stream(http: &reqwest::Client, id: &str) -> Result<Stream> {
    let track = get(http, &format!("/tracks/{id}"), &[]).await?;
    let transcodings = track.pointer("/media/transcodings").and_then(Value::as_array).cloned().unwrap_or_default();
    let pick = |protocol: &str| {
        transcodings.iter().find(|t| {
            t.pointer("/format/protocol").and_then(Value::as_str) == Some(protocol)
                && t.pointer("/format/mime_type").and_then(Value::as_str) == Some("audio/mpeg")
                && !t.get("snipped").and_then(Value::as_bool).unwrap_or(false)
        })
    };
    let auth = track.get("track_authorization").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(t) = pick("progressive") {
        let link = get(http, t.get("url").and_then(Value::as_str).unwrap_or_default(), &[("track_authorization", auth.clone())]).await?;
        if let Some(url) = link.get("url").and_then(Value::as_str) {
            return Ok(Stream::File(url.into()));
        }
    }
    if let Some(t) = pick("hls") {
        let link = get(http, t.get("url").and_then(Value::as_str).unwrap_or_default(), &[("track_authorization", auth)]).await?;
        let playlist_url = link.get("url").and_then(Value::as_str).ok_or_else(|| anyhow!("нет потока"))?;
        let playlist = http.get(playlist_url).send().await?.text().await?;
        if playlist.contains("#EXT-X-KEY") {
            bail!("трек защищён — SoundCloud отдаёт его только в своём приложении");
        }
        let segments: Vec<String> = playlist.lines().filter(|l| l.starts_with("http")).map(str::to_string).collect();
        if !segments.is_empty() {
            return Ok(Stream::Segments(segments));
        }
    }
    bail!("SoundCloud не отдаёт этот трек целиком")
}

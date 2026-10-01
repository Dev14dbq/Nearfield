//! Spotify Web API: metadata only (search, covers, artists, ISRC). Spotify audio is DRM-protected,
//! so it is never downloaded. Needs the user's own Client ID / Secret from developer.spotify.com.

use crate::merge::track_key;
use crate::model::{Album, Artist, ArtistPage, ArtistRef, Link, Source, Track};
use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

static TOKEN: OnceLock<Mutex<Option<(String, String, Instant)>>> = OnceLock::new();

async fn token(http: &reqwest::Client, client_id: &str, secret: &str) -> Result<String> {
    let cell = TOKEN.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().await;
    if let Some((id, token, until)) = guard.as_ref() {
        if id == client_id && Instant::now() < *until {
            return Ok(token.clone());
        }
    }
    let response: Value = http
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(client_id, Some(secret))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await?
        .json()
        .await?;
    let token = response
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Spotify: неверный Client ID или Secret"))?
        .to_string();
    let ttl = response.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    *guard = Some((client_id.into(), token.clone(), Instant::now() + Duration::from_secs(ttl.saturating_sub(60))));
    Ok(token)
}

pub struct Keys<'a> {
    pub id: &'a str,
    pub secret: &'a str,
}

async fn get(http: &reqwest::Client, keys: &Keys<'_>, path: &str, query: &[(&str, &str)]) -> Result<Value> {
    let token = token(http, keys.id, keys.secret).await?;
    let response = http.get(format!("https://api.spotify.com/v1{path}")).bearer_auth(token).query(query).send().await?;
    if !response.status().is_success() {
        bail!("Spotify: {}", response.status());
    }
    Ok(response.json().await?)
}

fn best_image(value: Option<&Value>) -> Option<String> {
    value?.as_array()?.first()?.get("url")?.as_str().map(str::to_string)
}

fn parse_track(t: &Value) -> Option<Track> {
    let artists: Vec<ArtistRef> = t
        .get("artists")?
        .as_array()?
        .iter()
        .filter_map(|a| {
            Some(ArtistRef {
                name: a.get("name")?.as_str()?.to_string(),
                id: a.get("id").and_then(Value::as_str).map(|id| format!("spotify:{id}")),
            })
        })
        .collect();
    let title = t.get("name")?.as_str()?.to_string();
    let album = t.get("album");
    Some(Track {
        id: track_key(&artists.first()?.name, &title),
        title,
        artists,
        album: album.and_then(|a| a.get("name")).and_then(Value::as_str).map(str::to_string),
        year: album.and_then(|a| a.get("release_date")).and_then(Value::as_str).and_then(|d| d.get(..4)?.parse().ok()),
        duration: t.get("duration_ms").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
        cover: best_image(album.and_then(|a| a.get("images"))),
        genre: None,
        explicit: t.get("explicit").and_then(Value::as_bool).unwrap_or(false),
        isrc: t.pointer("/external_ids/isrc").and_then(Value::as_str).map(str::to_string),
        sources: vec![Source {
            provider: "spotify".into(),
            id: t.get("id")?.as_str()?.to_string(),
            audio: "none".into(),
            url: t.pointer("/external_urls/spotify").and_then(Value::as_str).map(str::to_string),
        }],
        popularity: t.get("popularity").and_then(Value::as_f64),
    })
}

fn parse_artist(a: &Value) -> Option<Artist> {
    let id = a.get("id")?.as_str()?.to_string();
    Some(Artist {
        id: format!("spotify:{id}"),
        name: a.get("name")?.as_str()?.to_string(),
        image: best_image(a.get("images")),
        genres: a
            .get("genres")
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        followers: a.pointer("/followers/total").and_then(Value::as_i64),
        sources: vec![Source {
            provider: "spotify".into(),
            id,
            audio: "none".into(),
            url: a.pointer("/external_urls/spotify").and_then(Value::as_str).map(str::to_string),
        }],
    })
}

pub async fn search(http: &reqwest::Client, keys: &Keys<'_>, query: &str) -> Result<(Vec<Track>, Vec<Artist>)> {
    let result = get(http, keys, "/search", &[("q", query), ("type", "track,artist"), ("limit", "20")]).await?;
    let tracks = result
        .pointer("/tracks/items")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(parse_track).collect())
        .unwrap_or_default();
    let artists = result
        .pointer("/artists/items")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(parse_artist).take(6).collect())
        .unwrap_or_default();
    Ok((tracks, artists))
}

pub async fn artist_page(http: &reqwest::Client, keys: &Keys<'_>, id: &str) -> Result<ArtistPage> {
    let paths = (format!("/artists/{id}"), format!("/artists/{id}/top-tracks"), format!("/artists/{id}/albums"));
    let (artist, top, albums) = tokio::join!(
        get(http, keys, &paths.0, &[]),
        get(http, keys, &paths.1, &[("market", "US")]),
        get(http, keys, &paths.2, &[("include_groups", "album,single"), ("limit", "30")]),
    );
    let artist = parse_artist(&artist?).ok_or_else(|| anyhow!("артист не найден"))?;
    let tracks = top
        .ok()
        .and_then(|t| t.get("tracks").and_then(Value::as_array).cloned())
        .map(|l| l.iter().filter_map(parse_track).collect())
        .unwrap_or_default();
    let albums = albums
        .ok()
        .and_then(|a| a.get("items").and_then(Value::as_array).cloned())
        .map(|l| {
            l.iter()
                .filter_map(|a| {
                    Some(Album {
                        id: format!("spotify:{}", a.get("id")?.as_str()?),
                        title: a.get("name")?.as_str()?.to_string(),
                        year: a.get("release_date").and_then(Value::as_str).and_then(|d| d.get(..4)?.parse().ok()),
                        cover: best_image(a.get("images")),
                        kind: a.get("album_type").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let links = artist
        .sources
        .iter()
        .filter_map(|s| s.url.clone())
        .map(|url| Link { title: "Spotify".into(), url })
        .collect();
    Ok(ArtistPage {
        description: None,
        listeners: None,
        likes: artist.followers,
        images: artist.image.iter().cloned().collect(),
        tracks,
        albums,
        similar: vec![],
        links,
        providers: vec!["spotify".into()],
        artist,
    })
}

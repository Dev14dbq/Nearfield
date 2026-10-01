//! Yandex Music. Search, artists and covers work anonymously; full audio and lyrics
//! need the user's own OAuth token (they sign in through Yandex's own page).

use crate::merge::track_key;
use crate::model::{Album, Artist, ArtistPage, ArtistRef, Link, Lyrics, Source, Track};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

const API: &str = "https://api.music.yandex.net";
const CLIENT: &str = "YandexMusicAndroid/24023621";
/// Public client id of the official Android app; used for the user's own sign-in.
pub const OAUTH_CLIENT_ID: &str = "23cabbbdc6cd418abb4b39c32c41195d";
const SIGN_KEY: &[u8] = b"p93jhgh689SBReK6ghtw62";
const MP3_SALT: &str = "XGRlBW9FXlekgbPrRHuSiA";

pub fn oauth_url() -> String {
    format!("https://oauth.yandex.ru/authorize?response_type=token&client_id={OAUTH_CLIENT_ID}")
}

fn image(uri: Option<&str>, size: &str) -> Option<String> {
    uri.filter(|u| !u.is_empty()).map(|u| format!("https://{}", u.replace("%%", size)))
}

async fn get(http: &reqwest::Client, token: Option<&str>, path: &str, query: &[(&str, String)]) -> Result<Value> {
    let mut request = http.get(format!("{API}{path}")).header("X-Yandex-Music-Client", CLIENT).query(query);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        request = request.header("Authorization", format!("OAuth {token}"));
    }
    let response = request.send().await.context("Яндекс Музыка недоступна")?;
    let status = response.status();
    let body: Value = response.json().await.context("Яндекс Музыка: неожиданный ответ")?;
    if let Some(error) = body.get("error") {
        let name = error.get("name").and_then(Value::as_str).unwrap_or("error");
        if name == "not-authenticated" || status == 401 {
            bail!("нужен вход в Яндекс Музыку");
        }
        bail!("Яндекс Музыка: {name}");
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

fn artist_refs(value: &Value) -> Vec<ArtistRef> {
    value
        .get("artists")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(ArtistRef {
                        name: a.get("name")?.as_str()?.to_string(),
                        id: id_string(a.get("id")).map(|id| format!("yandex:{id}")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn id_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn parse_track(t: &Value, signed_in: bool) -> Option<Track> {
    let id = id_string(t.get("id"))?;
    let title = t.get("title")?.as_str()?.to_string();
    let version = t.get("version").and_then(Value::as_str).filter(|v| !v.is_empty());
    let title = match version {
        Some(v) => format!("{title} ({v})"),
        None => title,
    };
    let artists = artist_refs(t);
    let primary = artists.first().map(|a| a.name.clone()).unwrap_or_default();
    let album = t.get("albums").and_then(|a| a.get(0));
    let available = t.get("available").and_then(Value::as_bool).unwrap_or(true);
    let audio = if !available {
        "none"
    } else if signed_in {
        "full"
    } else {
        "preview"
    };
    Some(Track {
        id: track_key(&primary, &title),
        title,
        artists,
        album: album.and_then(|a| a.get("title")).and_then(Value::as_str).map(str::to_string),
        year: album.and_then(|a| a.get("year")).and_then(Value::as_i64),
        duration: t.get("durationMs").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
        cover: image(
            t.get("coverUri").and_then(Value::as_str).or_else(|| album.and_then(|a| a.get("coverUri")).and_then(Value::as_str)),
            "600x600",
        ),
        genre: album.and_then(|a| a.get("genre")).and_then(Value::as_str).map(str::to_string),
        explicit: t.get("contentWarning").and_then(Value::as_str) == Some("explicit"),
        isrc: None,
        sources: vec![Source {
            provider: "yandex".into(),
            id: match album.and_then(|a| id_string(a.get("id"))) {
                Some(album_id) => format!("{id}:{album_id}"),
                None => id,
            },
            audio: audio.into(),
            url: None,
        }],
        popularity: None,
    })
}

fn parse_artist(a: &Value) -> Option<Artist> {
    let id = id_string(a.get("id"))?;
    Some(Artist {
        id: format!("yandex:{id}"),
        name: a.get("name")?.as_str()?.to_string(),
        image: image(a.get("cover").and_then(|c| c.get("uri")).and_then(Value::as_str), "400x400"),
        genres: a
            .get("genres")
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        followers: a.get("likesCount").and_then(Value::as_i64),
        sources: vec![Source { provider: "yandex".into(), id, audio: "none".into(), url: None }],
    })
}

pub async fn search(http: &reqwest::Client, token: Option<&str>, query: &str) -> Result<(Vec<Track>, Vec<Artist>)> {
    let result = get(http, token, "/search", &[("text", query.to_string()), ("type", "all".into()), ("page", "0".into())]).await?;
    let signed_in = token.is_some_and(|t| !t.is_empty());
    let mut tracks: Vec<Track> = Vec::new();
    // The "best" hit goes first when it is a track.
    if let Some(best) = result.get("best").filter(|b| b.get("type").and_then(Value::as_str) == Some("track")) {
        if let Some(track) = best.get("result").and_then(|t| parse_track(t, signed_in)) {
            tracks.push(track);
        }
    }
    if let Some(list) = result.pointer("/tracks/results").and_then(Value::as_array) {
        tracks.extend(list.iter().filter_map(|t| parse_track(t, signed_in)));
    }
    let artists = result
        .pointer("/artists/results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_artist).collect())
        .unwrap_or_default();
    Ok((tracks, artists))
}

pub async fn artist_page(http: &reqwest::Client, token: Option<&str>, id: &str) -> Result<ArtistPage> {
    let result = get(http, token, &format!("/artists/{id}/brief-info"), &[]).await?;
    let raw = result.get("artist").ok_or_else(|| anyhow!("артист не найден"))?;
    let artist = parse_artist(raw).ok_or_else(|| anyhow!("артист не найден"))?;
    let signed_in = token.is_some_and(|t| !t.is_empty());
    let tracks = result
        .get("popularTracks")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|t| parse_track(t, signed_in)).collect())
        .unwrap_or_default();
    let albums = result
        .get("albums")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Album {
                        id: format!("yandex:{}", id_string(a.get("id"))?),
                        title: a.get("title")?.as_str()?.to_string(),
                        year: a.get("year").and_then(Value::as_i64),
                        cover: image(a.get("coverUri").and_then(Value::as_str), "400x400"),
                        kind: a.get("type").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let similar = result
        .get("similarArtists")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_artist).collect())
        .unwrap_or_default();
    let links = result
        .get("links")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|l| {
                    Some(Link { title: l.get("title")?.as_str()?.to_string(), url: l.get("url")?.as_str()?.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    let images = result
        .get("allCovers")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|c| image(c.get("uri").and_then(Value::as_str), "1000x1000")).take(8).collect())
        .unwrap_or_default();
    let description = raw
        .pointer("/description/text")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(ArtistPage {
        description,
        listeners: result.pointer("/stats/lastMonthListeners").and_then(Value::as_i64),
        likes: raw.get("likesCount").and_then(Value::as_i64),
        images,
        tracks,
        albums,
        similar,
        links,
        providers: vec!["yandex".into()],
        artist,
    })
}

pub async fn album_tracks(http: &reqwest::Client, token: Option<&str>, id: &str) -> Result<Vec<Track>> {
    let result = get(http, token, &format!("/albums/{id}/with-tracks"), &[]).await?;
    let signed_in = token.is_some_and(|t| !t.is_empty());
    let mut tracks = Vec::new();
    for volume in result.get("volumes").and_then(Value::as_array).into_iter().flatten() {
        for t in volume.as_array().into_iter().flatten() {
            if let Some(track) = parse_track(t, signed_in) {
                tracks.push(track);
            }
        }
    }
    Ok(tracks)
}

fn track_id(source_id: &str) -> &str {
    source_id.split(':').next().unwrap_or(source_id)
}

fn sign(text: &str) -> String {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(SIGN_KEY).expect("hmac key");
    mac.update(text.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

pub async fn lyrics(http: &reqwest::Client, token: &str, source_id: &str) -> Result<Option<Lyrics>> {
    let id = track_id(source_id);
    for format in ["LRC", "TEXT"] {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs().to_string();
        let result = match get(
            http,
            Some(token),
            &format!("/tracks/{id}/lyrics"),
            &[("format", format.into()), ("timeStamp", ts.clone()), ("sign", sign(&format!("{id}{ts}")))],
        )
        .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Some(url) = result.get("downloadUrl").and_then(Value::as_str) else { continue };
        let text = http.get(url).send().await?.text().await?;
        if !text.trim().is_empty() {
            return Ok(Some(Lyrics { synced: format == "LRC", text, source: "Яндекс Музыка".into() }));
        }
    }
    Ok(None)
}

/// Direct MP3 link of the best quality the account may stream.
pub async fn audio_url(http: &reqwest::Client, token: Option<&str>, source_id: &str) -> Result<String> {
    let id = track_id(source_id);
    let info = get(http, token, &format!("/tracks/{id}/download-info"), &[]).await?;
    let best = info
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.get("codec").and_then(Value::as_str) == Some("mp3"))
        .max_by_key(|v| v.get("bitrateInKbps").and_then(Value::as_i64).unwrap_or(0))
        .ok_or_else(|| anyhow!("Яндекс не дал ссылку на трек"))?;
    let info_url = best.get("downloadInfoUrl").and_then(Value::as_str).ok_or_else(|| anyhow!("нет ссылки"))?;
    let xml = http.get(info_url).send().await?.text().await?;
    let tag = |name: &str| -> Result<String> {
        let start = xml.find(&format!("<{name}>")).ok_or_else(|| anyhow!("ответ без {name}"))? + name.len() + 2;
        let end = xml[start..].find(&format!("</{name}>")).ok_or_else(|| anyhow!("ответ без {name}"))? + start;
        Ok(xml[start..end].to_string())
    };
    let (host, path, ts, s) = (tag("host")?, tag("path")?, tag("ts")?, tag("s")?);
    use md5::{Digest, Md5};
    let digest = Md5::digest(format!("{MP3_SALT}{}{s}", &path[1..]).as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("https://{host}/get-mp3/{hash}/{ts}{path}"))
}

/// Account name for the settings screen; also validates the token.
pub async fn account(http: &reqwest::Client, token: &str) -> Result<(String, bool)> {
    let result = get(http, Some(token), "/account/status", &[]).await?;
    let login = result
        .pointer("/account/displayName")
        .or_else(|| result.pointer("/account/login"))
        .and_then(Value::as_str)
        .unwrap_or("аккаунт")
        .to_string();
    let plus = result.pointer("/plus/hasPlus").and_then(Value::as_bool).unwrap_or(false);
    Ok((login, plus))
}

/// Seconds since the epoch from an ISO-8601 time like "2024-05-01T12:34:56+03:00".
fn iso_seconds(text: &str) -> Option<i64> {
    let (date, rest) = text.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = &rest[..rest.len().min(8)];
    let mut t = time.split(':').map(|x| x.parse::<i64>().ok());
    let (h, min, sec) = (t.next()??, t.next()??, t.next()??);
    // Days from the civil calendar (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut offset = 0;
    if let Some(pos) = rest.rfind(['+', '-']).filter(|&p| p >= 8) {
        let sign = if &rest[pos..pos + 1] == "-" { -1 } else { 1 };
        let tz: Vec<i64> = rest[pos + 1..].split(':').filter_map(|x| x.parse().ok()).collect();
        offset = sign * (tz.first().copied().unwrap_or(0) * 3600 + tz.get(1).copied().unwrap_or(0) * 60);
    }
    Some(days * 86400 + h * 3600 + min * 60 + sec - offset)
}

/// The user's liked tracks with the moment each was liked.
pub async fn liked_tracks(http: &reqwest::Client, token: &str) -> Result<Vec<(Track, Option<i64>)>> {
    let status = get(http, Some(token), "/account/status", &[]).await?;
    let uid = id_string(status.pointer("/account/uid")).ok_or_else(|| anyhow!("нет номера аккаунта"))?;
    let likes = get(http, Some(token), &format!("/users/{uid}/likes/tracks"), &[]).await?;
    let refs: Vec<(String, Option<i64>)> = likes
        .pointer("/library/tracks")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    let id = id_string(t.get("id"))?;
                    let key = match id_string(t.get("albumId")) {
                        Some(album) => format!("{id}:{album}"),
                        None => id,
                    };
                    Some((key, t.get("timestamp").and_then(Value::as_str).and_then(iso_seconds)))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for chunk in refs.chunks(100) {
        let ids = chunk.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(",");
        let response = http
            .post(format!("{API}/tracks"))
            .header("X-Yandex-Music-Client", CLIENT)
            .header("Authorization", format!("OAuth {token}"))
            .form(&[("track-ids", ids)])
            .send()
            .await?;
        let body: Value = response.json().await?;
        for t in body.get("result").and_then(Value::as_array).into_iter().flatten() {
            let Some(track) = parse_track(t, true) else { continue };
            let id = id_string(t.get("id")).unwrap_or_default();
            let at = chunk.iter().find(|(k, _)| k.split(':').next() == Some(id.as_str())).and_then(|(_, at)| *at);
            out.push((track, at));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod time_tests {
    #[test]
    fn iso() {
        assert_eq!(super::iso_seconds("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(super::iso_seconds("2024-05-01T12:00:00+03:00"), Some(1714554000));
        assert_eq!(super::iso_seconds("2000-02-29T23:59:59Z"), Some(951868799));
    }
}

/// "My Wave" and activity stations: Yandex's own recommendations from the user's listening.
/// `settings` (moodEnergy, diversity, language) apply to the personal wave only.
pub async fn wave(http: &reqwest::Client, token: &str, station: &str, settings: Option<&Value>, after: Option<&str>) -> Result<(Vec<Track>, String)> {
    if let Some(settings) = settings {
        http.post(format!("{API}/rotor/station/{station}/settings3"))
            .header("X-Yandex-Music-Client", CLIENT)
            .header("Authorization", format!("OAuth {token}"))
            .json(settings)
            .send()
            .await?
            .error_for_status()?;
    }
    let mut query = vec![("settings2", "true".to_string())];
    // `after`: comma-separated "track:album" ids already queued, so the wave continues past them.
    if let Some(after) = after.filter(|a| !a.is_empty()) {
        query.push(("queue", after.to_string()));
    }
    let result = get(http, Some(token), &format!("/rotor/station/{station}/tracks"), &query).await?;
    let batch = result.get("batchId").and_then(Value::as_str).unwrap_or("").to_string();
    let tracks = result
        .get("sequence")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|x| x.get("track")).filter_map(|t| parse_track(t, true)).collect())
        .unwrap_or_default();
    Ok((tracks, batch))
}

/// Tells the wave what happened, so the next tracks fit better (skips teach it the most).
pub async fn wave_feedback(http: &reqwest::Client, token: &str, station: &str, batch: &str, kind: &str, track: Option<&str>, played: f64) -> Result<()> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs_f64();
    let mut body = serde_json::json!({ "type": kind, "timestamp": ts, "from": "desktop-wave" });
    if let Some(track) = track {
        body["trackId"] = Value::String(track.to_string());
        body["totalPlayedSeconds"] = serde_json::json!(played);
    }
    http.post(format!("{API}/rotor/station/{station}/feedback"))
        .query(&[("batch-id", batch)])
        .header("X-Yandex-Music-Client", CLIENT)
        .header("Authorization", format!("OAuth {token}"))
        .json(&body)
        .send()
        .await?;
    Ok(())
}

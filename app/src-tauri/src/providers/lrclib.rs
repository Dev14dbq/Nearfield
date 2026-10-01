//! LRCLIB — open database of synced lyrics (lrclib.net), no account needed.

use crate::model::{Lyrics, Track};
use anyhow::Result;
use serde_json::Value;

pub async fn lyrics(http: &reqwest::Client, track: &Track) -> Result<Option<Lyrics>> {
    let artist = track.artists.first().map(|a| a.name.as_str()).unwrap_or("");
    let mut query = vec![("artist_name", artist.to_string()), ("track_name", track.title.clone())];
    if track.duration > 0.0 {
        query.push(("duration", format!("{}", track.duration.round() as i64)));
    }
    let mut response = http.get("https://lrclib.net/api/get").query(&query).send().await?;
    if response.status() == 404 {
        // Duration often differs by a few seconds between releases; fall back to search.
        response = http
            .get("https://lrclib.net/api/search")
            .query(&[("artist_name", artist), ("track_name", track.title.as_str())])
            .send()
            .await?;
    }
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await?;
    let candidates: Vec<Value> = match body {
        Value::Array(list) => list,
        other => vec![other],
    };
    let close = |v: &&Value| {
        let d = v.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        track.duration <= 0.0 || d <= 0.0 || (d - track.duration).abs() <= 8.0
    };
    let synced = candidates
        .iter()
        .filter(close)
        .find_map(|v| v.get("syncedLyrics").and_then(Value::as_str).filter(|s| !s.trim().is_empty()));
    if let Some(text) = synced {
        return Ok(Some(Lyrics { synced: true, text: text.into(), source: "LRCLIB".into() }));
    }
    let plain = candidates
        .iter()
        .filter(close)
        .find_map(|v| v.get("plainLyrics").and_then(Value::as_str).filter(|s| !s.trim().is_empty()));
    Ok(plain.map(|text| Lyrics { synced: false, text: text.into(), source: "LRCLIB".into() }))
}

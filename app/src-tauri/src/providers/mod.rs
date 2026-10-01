pub mod lrclib;
pub mod soundcloud;
pub mod spotify;
pub mod yandex;

use crate::merge::{merge_artists, merge_tracks, norm_name};
use crate::model::{ArtistPage, Lyrics, SearchResult, Track};
use anyhow::{bail, Result};

#[derive(Clone, Default)]
pub struct Accounts {
    pub yandex_token: Option<String>,
    pub spotify_id: Option<String>,
    pub spotify_secret: Option<String>,
}

impl Accounts {
    fn spotify(&self) -> Option<spotify::Keys<'_>> {
        match (self.spotify_id.as_deref(), self.spotify_secret.as_deref()) {
            (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Some(spotify::Keys { id, secret }),
            _ => None,
        }
    }
}

pub async fn search(http: &reqwest::Client, accounts: &Accounts, query: &str) -> SearchResult {
    let token = accounts.yandex_token.as_deref();
    let spotify_keys = accounts.spotify();
    let spotify_search = async {
        match &spotify_keys {
            Some(keys) => Some(spotify::search(http, keys, query).await),
            None => None,
        }
    };
    let (ya, sc, sp) = tokio::join!(yandex::search(http, token, query), soundcloud::search(http, query), spotify_search);
    let mut result = SearchResult::default();
    let mut track_lists = Vec::new();
    let mut artist_lists = Vec::new();
    for (name, outcome) in [("Яндекс Музыка", Some(ya)), ("Spotify", sp), ("SoundCloud", Some(sc))] {
        match outcome {
            Some(Ok((tracks, artists))) => {
                track_lists.push(tracks);
                artist_lists.push(artists);
            }
            Some(Err(error)) => result.errors.push(format!("{name}: {error}")),
            None => {}
        }
    }
    result.tracks = merge_tracks(track_lists);
    result.artists = merge_artists(artist_lists);
    result
}

/// `id` is provider-scoped: "yandex:1438", "soundcloud:123", "spotify:abc".
pub async fn artist_page(http: &reqwest::Client, accounts: &Accounts, id: &str) -> Result<ArtistPage> {
    let (provider, raw) = id.split_once(':').unwrap_or(("yandex", id));
    let mut page = match provider {
        "yandex" => yandex::artist_page(http, accounts.yandex_token.as_deref(), raw).await?,
        "soundcloud" => soundcloud::artist_page(http, raw).await?,
        "spotify" => match accounts.spotify() {
            Some(keys) => spotify::artist_page(http, &keys, raw).await?,
            None => bail!("Spotify не подключён"),
        },
        _ => bail!("неизвестный сервис"),
    };
    // Fill the page from the other services that know this artist.
    let name = norm_name(&page.artist.name);
    if provider != "yandex" {
        if let Ok((_, artists)) = yandex::search(http, accounts.yandex_token.as_deref(), &page.artist.name).await {
            if let Some(found) = artists.iter().find(|a| norm_name(&a.name) == name) {
                if let Ok(other) = yandex::artist_page(http, accounts.yandex_token.as_deref(), &found.id["yandex:".len()..]).await {
                    enrich(&mut page, other);
                }
            }
        }
    }
    if provider != "soundcloud" {
        if let Ok((_, users)) = soundcloud::search(http, &page.artist.name).await {
            if let Some(found) = users.iter().find(|a| norm_name(&a.name) == name) {
                page.artist.sources.extend(found.sources.clone());
                if let Some(url) = found.sources.first().and_then(|s| s.url.clone()) {
                    page.links.push(crate::model::Link { title: "SoundCloud".into(), url });
                }
                page.providers.push("soundcloud".into());
            }
        }
    }
    if provider != "spotify" {
        if let Some(keys) = accounts.spotify() {
            if let Ok((_, artists)) = spotify::search(http, &keys, &page.artist.name).await {
                if let Some(found) = artists.into_iter().find(|a| norm_name(&a.name) == name) {
                    if page.artist.genres.is_empty() {
                        page.artist.genres = found.genres.clone();
                    }
                    if let Some(url) = found.sources.first().and_then(|s| s.url.clone()) {
                        page.links.push(crate::model::Link { title: "Spotify".into(), url });
                    }
                    page.artist.sources.extend(found.sources);
                    page.providers.push("spotify".into());
                }
            }
        }
    }
    Ok(page)
}

fn enrich(page: &mut ArtistPage, other: ArtistPage) {
    page.description = page.description.take().or(other.description);
    page.listeners = page.listeners.or(other.listeners);
    if page.artist.image.is_none() {
        page.artist.image = other.artist.image;
    }
    page.images.extend(other.images);
    page.tracks = merge_tracks(vec![other.tracks, std::mem::take(&mut page.tracks)]);
    if page.albums.is_empty() {
        page.albums = other.albums;
    }
    if page.similar.is_empty() {
        page.similar = other.similar;
    }
    page.links.extend(other.links);
    page.artist.sources.extend(other.artist.sources);
    page.providers.extend(other.providers);
}

pub async fn album_tracks(http: &reqwest::Client, accounts: &Accounts, id: &str) -> Result<Vec<Track>> {
    match id.split_once(':') {
        Some(("yandex", raw)) => yandex::album_tracks(http, accounts.yandex_token.as_deref(), raw).await,
        _ => bail!("альбом доступен только из Яндекс Музыки"),
    }
}

/// Lyrics only from where the track came from (Yandex, signed in) or the open LRCLIB database.
pub async fn lyrics(http: &reqwest::Client, accounts: &Accounts, track: &Track) -> Option<Lyrics> {
    if let Some(token) = accounts.yandex_token.as_deref().filter(|t| !t.is_empty()) {
        if let Some(source) = track.sources.iter().find(|s| s.provider == "yandex") {
            if let Ok(Some(lyrics)) = yandex::lyrics(http, token, &source.id).await {
                if lyrics.synced {
                    return Some(lyrics);
                }
                // Plain text from Yandex; LRCLIB may still have a synced version.
                return lrclib::lyrics(http, track).await.ok().flatten().filter(|l| l.synced).or(Some(lyrics));
            }
        }
    }
    lrclib::lyrics(http, track).await.ok().flatten()
}

#[cfg(test)]
mod live {
    use super::*;

    /// Hits the real services: `cargo test live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn search_and_artist() {
        let http = reqwest::Client::builder().user_agent("Mozilla/5.0").build().unwrap();
        let accounts = Accounts::default();
        let result = search(&http, &accounts, "lady gaga poker face").await;
        println!("errors: {:?}", result.errors);
        for t in result.tracks.iter().take(8) {
            let sources: Vec<String> = t.sources.iter().map(|s| format!("{}:{}", s.provider, s.audio)).collect();
            println!("{} — {} [{:.0}s] {:?}", t.artists[0].name, t.title, t.duration, sources);
        }
        println!("artists: {:?}", result.artists.iter().map(|a| (&a.name, a.sources.len())).collect::<Vec<_>>());
        assert!(!result.tracks.is_empty());
        let first = &result.tracks[0];
        assert!(first.sources.len() >= 2, "same song from two services should merge");
        let page = artist_page(&http, &accounts, "yandex:1438").await.unwrap();
        println!("artist {} listeners {:?} tracks {} albums {} similar {} providers {:?}", page.artist.name, page.listeners, page.tracks.len(), page.albums.len(), page.similar.len(), page.providers);
        let lyrics = lyrics(&http, &accounts, first).await;
        println!("lyrics: {:?}", lyrics.map(|l| (l.synced, l.source, l.text.chars().take(60).collect::<String>())));
        let sc = result.tracks.iter().flat_map(|t| t.sources.iter()).find(|s| s.provider == "soundcloud" && s.audio == "full").unwrap();
        match soundcloud::stream(&http, &sc.id).await.unwrap() {
            soundcloud::Stream::File(u) => println!("sc file {}", &u[..60.min(u.len())]),
            soundcloud::Stream::Segments(s) => println!("sc segments {}", s.len()),
        }
    }
}

#[cfg(test)]
mod fixtures {
    use super::*;

    /// Dumps real responses for UI checks outside the app: `FIXTURES=dir cargo test fixtures -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn dump() {
        let dir = std::env::var("FIXTURES").unwrap();
        let http = reqwest::Client::builder().user_agent("Mozilla/5.0").build().unwrap();
        let accounts = Accounts::default();
        let search = search(&http, &accounts, "lady gaga").await;
        std::fs::write(format!("{dir}/search.json"), serde_json::to_string(&search).unwrap()).unwrap();
        let page = artist_page(&http, &accounts, "yandex:1438").await.unwrap();
        std::fs::write(format!("{dir}/artist.json"), serde_json::to_string(&page).unwrap()).unwrap();
        let lyrics = lyrics(&http, &accounts, &search.tracks[0]).await;
        std::fs::write(format!("{dir}/lyrics.json"), serde_json::to_string(&lyrics).unwrap()).unwrap();
    }
}

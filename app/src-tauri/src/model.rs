use serde::{Deserialize, Serialize};

/// Where a track (or artist) was found. `id` is the provider's own id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub provider: String,
    pub id: String,
    /// "full" — whole track can be fetched, "preview" — only a snippet, "none" — metadata only.
    pub audio: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtistRef {
    pub name: String,
    /// Provider-scoped id, e.g. "yandex:1438" or "soundcloud:123".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// Canonical id: the same song from different services gets the same id.
    pub id: String,
    pub title: String,
    pub artists: Vec<ArtistRef>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub year: Option<i64>,
    /// Seconds.
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Popularity hint from the provider (plays / likes), used only for ranking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub popularity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    /// Provider-scoped id of the best source, e.g. "yandex:1438".
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub followers: Option<i64>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Album {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtistPage {
    pub artist: Artist,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub listeners: Option<i64>,
    #[serde(default)]
    pub likes: Option<i64>,
    #[serde(default)]
    pub images: Vec<String>,
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub similar: Vec<Artist>,
    pub links: Vec<Link>,
    /// Which services contributed to this page.
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchResult {
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
    /// Services that failed, with a short reason, so the UI can say so.
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lyrics {
    pub synced: bool,
    pub text: String,
    pub source: String,
}

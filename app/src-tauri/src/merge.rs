//! The same song from Yandex, SoundCloud and Spotify must show up once.
//! Tracks are keyed by a normalised "artist | title"; versions that really differ
//! (remix, live, slowed, acoustic…) keep those words in the title and stay separate.

use crate::model::{Artist, Track};
use regex::Regex;
use std::sync::OnceLock;

fn noise() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Bracketed parts that do not change the recording.
    RE.get_or_init(|| {
        Regex::new(r"(?i)[\(\[](?:[^\)\]]*\b(?:feat|ft|prod|explicit|clean|official|video|audio|lyrics?|lyric video|visuali[sz]er|hq|hd|4k|remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?|radio edit|album version|original mix|bonus track|from [^\)\]]*)\b[^\)\]]*)[\)\]]").unwrap()
    })
}

fn feat() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\s+(?:feat\.?|ft\.?|featuring|при уч\.?)\s+.*$").unwrap())
}

fn dash_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?$|\s+-\s+(?:radio edit|single version|album version|original mix)$").unwrap())
}

/// Lower-case, without noise in brackets, featured artists and punctuation.
pub fn norm_title(title: &str) -> String {
    let t = noise().replace_all(title, " ");
    let t = dash_suffix().replace_all(&t, "");
    let t = feat().replace_all(&t, "");
    squash(&t)
}

pub fn norm_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let first = lower
        .split(|c| c == ',' || c == '&' || c == '×')
        .next()
        .unwrap_or(&lower)
        .split(" feat")
        .next()
        .unwrap_or("")
        .split(" ft.")
        .next()
        .unwrap_or("")
        .split(" x ")
        .next()
        .unwrap_or("");
    squash(first.trim_start_matches("the "))
}

fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.to_lowercase().chars() {
        let c = if c == 'ё' { 'е' } else { c };
        if c.is_alphanumeric() {
            out.push(c);
            space = false;
        } else if !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

pub fn track_key(artist: &str, title: &str) -> String {
    format!("{}|{}", norm_name(artist), norm_title(title))
}

/// Short stable id used for folders and the database.
pub fn short_hash(text: &str) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(text.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Merges per-provider result lists (each already in that provider's relevance order).
/// The first list wins ties; metadata from richer services fills the gaps.
pub fn merge_tracks(lists: Vec<Vec<Track>>) -> Vec<Track> {
    let mut merged: Vec<(f64, Track)> = Vec::new();
    for (list_index, list) in lists.into_iter().enumerate() {
        for (rank, track) in list.into_iter().enumerate() {
            let score = rank as f64 + list_index as f64 * 0.35;
            let existing = merged.iter_mut().find(|(_, other)| {
                other.id == track.id
                    && (other.duration <= 0.0 || track.duration <= 0.0 || (other.duration - track.duration).abs() <= 6.0)
            });
            match existing {
                Some((best, other)) => {
                    *best = best.min(score);
                    absorb(other, track);
                }
                None => merged.push((score, track)),
            }
        }
    }
    // Several sources for one song = it is the real thing, nudge it up.
    merged.sort_by(|a, b| {
        let a_score = a.0 - a.1.sources.len() as f64 * 0.6;
        let b_score = b.0 - b.1.sources.len() as f64 * 0.6;
        a_score.partial_cmp(&b_score).unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.into_iter().map(|(_, track)| track).collect()
}

pub fn absorb(target: &mut Track, other: Track) {
    for source in other.sources {
        if !target.sources.iter().any(|s| s.provider == source.provider && s.id == source.id) {
            target.sources.push(source);
        }
    }
    if target.cover.is_none() {
        target.cover = other.cover;
    }
    if target.album.is_none() {
        target.album = other.album;
    }
    if target.year.is_none() {
        target.year = other.year;
    }
    if target.genre.is_none() {
        target.genre = other.genre;
    }
    if target.isrc.is_none() {
        target.isrc = other.isrc;
    }
    if target.duration <= 0.0 {
        target.duration = other.duration;
    }
    target.explicit |= other.explicit;
    for artist in other.artists {
        if let Some(existing) = target.artists.iter_mut().find(|a| norm_name(&a.name) == norm_name(&artist.name)) {
            if existing.id.is_none() {
                existing.id = artist.id;
            }
        }
    }
}

pub fn merge_artists(lists: Vec<Vec<Artist>>) -> Vec<Artist> {
    let mut merged: Vec<Artist> = Vec::new();
    for list in lists {
        for artist in list {
            let key = norm_name(&artist.name);
            match merged.iter_mut().find(|a| norm_name(&a.name) == key) {
                Some(existing) => {
                    for source in artist.sources {
                        if !existing.sources.contains(&source) {
                            existing.sources.push(source);
                        }
                    }
                    if existing.image.is_none() {
                        existing.image = artist.image;
                    }
                    if existing.genres.is_empty() {
                        existing.genres = artist.genres;
                    }
                    existing.followers = existing.followers.max(artist.followers);
                }
                None => merged.push(artist),
            }
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_song_same_key() {
        assert_eq!(track_key("Lady Gaga", "Poker Face"), track_key("LADY GAGA", "Poker Face (Official Audio)"));
        assert_eq!(track_key("The Weeknd", "Blinding Lights"), track_key("Weeknd", "Blinding Lights - 2020 Remaster"));
        assert_eq!(track_key("Drake feat. Rihanna", "Too Good"), track_key("Drake", "Too Good (feat. Rihanna)"));
        assert_eq!(track_key("Кино", "Звезда по имени Солнце"), track_key("кино", "Звезда по имени солнце!"));
    }

    #[test]
    fn versions_stay_apart() {
        assert_ne!(track_key("Lady Gaga", "Poker Face"), track_key("Lady Gaga", "Poker Face (Slowed + Reverb)"));
        assert_ne!(track_key("Lady Gaga", "Poker Face"), track_key("Lady Gaga", "Poker Face - Remix"));
        assert_ne!(track_key("Lady Gaga", "Poker Face"), track_key("Lady Gaga", "Poker Face (Live)"));
    }
}

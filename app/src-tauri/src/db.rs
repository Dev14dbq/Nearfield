//! Local library: tracks the user kept (favourites, playlists, history), their files and analysis.

use crate::model::{Lyrics, Track};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

/// Preparation pipeline of a track: nothing → audio downloaded → separated into stems.
pub mod state {
    pub const DOWNLOADING: &str = "downloading";
    pub const DOWNLOADED: &str = "downloaded";
    pub const SEPARATING: &str = "separating";
    pub const READY: &str = "ready";
    pub const ERROR: &str = "error";
}

#[derive(Serialize, Clone)]
pub struct LibraryTrack {
    #[serde(flatten)]
    pub track: Track,
    pub favorite: bool,
    pub state: String,
    pub error: Option<String>,
    pub audio: Option<String>,
    pub stems: Option<HashMap<String, String>>,
    pub analysis: Option<Value>,
    pub preview: bool,
    pub added_at: i64,
    pub plays: i64,
}

#[derive(Serialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub covers: Vec<String>,
    pub ready: i64,
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

const TRACK_COLUMNS: &str = "data, favorite, state, error, audio, stems, analysis, preview, added_at, plays";

fn row_to_track(row: &rusqlite::Row) -> rusqlite::Result<LibraryTrack> {
    let data: String = row.get(0)?;
    let stems: Option<String> = row.get(5)?;
    let analysis: Option<String> = row.get(6)?;
    Ok(LibraryTrack {
        track: serde_json::from_str(&data).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        favorite: row.get::<_, i64>(1)? != 0,
        state: row.get(2)?,
        error: row.get(3)?,
        audio: row.get(4)?,
        stems: stems.and_then(|s| serde_json::from_str(&s).ok()),
        analysis: analysis.and_then(|s| serde_json::from_str(&s).ok()),
        preview: row.get::<_, i64>(7)? != 0,
        added_at: row.get(8)?,
        plays: row.get(9)?,
    })
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS tracks (
               id TEXT PRIMARY KEY,
               data TEXT NOT NULL,
               favorite INTEGER NOT NULL DEFAULT 0,
               fav_at INTEGER,
               state TEXT NOT NULL DEFAULT 'new',
               error TEXT,
               audio TEXT,
               stems TEXT,
               analysis TEXT,
               preview INTEGER NOT NULL DEFAULT 0,
               lyrics TEXT,
               lyrics_at INTEGER,
               added_at INTEGER NOT NULL,
               plays INTEGER NOT NULL DEFAULT 0,
               last_played INTEGER
             );
             CREATE TABLE IF NOT EXISTS playlists (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS playlist_tracks (
               playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
               track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
               position INTEGER NOT NULL,
               PRIMARY KEY (playlist_id, track_id)
             );
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { conn })
    }

    /// Inserts the track or refreshes its metadata (new sources, better cover), keeping local state.
    pub fn upsert(&self, track: &Track) -> Result<()> {
        let existing: Option<String> = self.conn.query_row("SELECT data FROM tracks WHERE id = ?", [&track.id], |r| r.get(0)).optional()?;
        let merged = match existing.and_then(|d| serde_json::from_str::<Track>(&d).ok()) {
            Some(mut old) => {
                crate::merge::absorb(&mut old, track.clone());
                // Fresh audio availability (e.g. after signing in) wins over the stored one.
                for source in &track.sources {
                    if let Some(s) = old.sources.iter_mut().find(|s| s.provider == source.provider && s.id == source.id) {
                        s.audio = source.audio.clone();
                    }
                }
                old
            }
            None => track.clone(),
        };
        self.conn.execute(
            "INSERT INTO tracks (id, data, added_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![merged.id, serde_json::to_string(&merged)?, now()],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<LibraryTrack>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?"), [id], row_to_track)
            .optional()?)
    }

    pub fn many(&self, ids: &[String]) -> Result<HashMap<String, LibraryTrack>> {
        let mut out = HashMap::new();
        for id in ids {
            if let Some(t) = self.get(id)? {
                out.insert(id.clone(), t);
            }
        }
        Ok(out)
    }

    pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET favorite = ?2, fav_at = CASE WHEN ?2 THEN ?3 ELSE fav_at END WHERE id = ?1",
            params![id, favorite, now()],
        )?;
        Ok(())
    }

    pub fn favorites(&self) -> Result<Vec<LibraryTrack>> {
        self.query(&format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE favorite = 1 ORDER BY fav_at DESC"), [])
    }

    pub fn history(&self, limit: i64) -> Result<Vec<LibraryTrack>> {
        self.query(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE last_played IS NOT NULL ORDER BY last_played DESC LIMIT ?"),
            [limit],
        )
    }

    /// Everything the user keeps: favourites and playlist tracks. Mood mixes pick from here.
    pub fn kept(&self) -> Result<Vec<LibraryTrack>> {
        self.query(
            &format!(
                "SELECT {TRACK_COLUMNS} FROM tracks WHERE favorite = 1 OR id IN (SELECT track_id FROM playlist_tracks)
                 OR plays >= 2 ORDER BY COALESCE(fav_at, added_at) DESC"
            ),
            [],
        )
    }

    fn query<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<LibraryTrack>> {
        let mut statement = self.conn.prepare(sql)?;
        let rows = statement.query_map(params, row_to_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn played(&self, id: &str) -> Result<()> {
        self.conn.execute("UPDATE tracks SET plays = plays + 1, last_played = ?2 WHERE id = ?1", params![id, now()])?;
        Ok(())
    }

    pub fn set_state(&self, id: &str, state: &str, error: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE tracks SET state = ?2, error = ?3 WHERE id = ?1", params![id, state, error])?;
        Ok(())
    }

    pub fn set_audio(&self, id: &str, path: &str, preview: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET audio = ?2, preview = ?3, state = ?4, error = NULL WHERE id = ?1",
            params![id, path, preview, state::DOWNLOADED],
        )?;
        Ok(())
    }

    pub fn set_stems(&self, id: &str, stems: &HashMap<String, String>) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET stems = ?2, state = ?3, error = NULL WHERE id = ?1",
            params![id, serde_json::to_string(stems)?, state::READY],
        )?;
        Ok(())
    }

    pub fn set_analysis(&self, id: &str, analysis: &Value) -> Result<()> {
        self.conn.execute("UPDATE tracks SET analysis = ?2 WHERE id = ?1", params![id, analysis.to_string()])?;
        Ok(())
    }

    pub fn lyrics(&self, id: &str) -> Result<Option<(Option<Lyrics>, i64)>> {
        Ok(self
            .conn
            .query_row("SELECT lyrics, lyrics_at FROM tracks WHERE id = ? AND lyrics_at IS NOT NULL", [id], |r| {
                let text: Option<String> = r.get(0)?;
                Ok((text.and_then(|t| serde_json::from_str(&t).ok()), r.get(1)?))
            })
            .optional()?)
    }

    pub fn set_lyrics(&self, id: &str, lyrics: Option<&Lyrics>) -> Result<()> {
        let text = lyrics.map(serde_json::to_string).transpose()?;
        self.conn.execute("UPDATE tracks SET lyrics = ?2, lyrics_at = ?3 WHERE id = ?1", params![id, text, now()])?;
        Ok(())
    }

    /// Next kept track that still needs work, favourites first, newest first.
    pub fn next_to_prepare(&self, separate: bool) -> Result<Option<LibraryTrack>> {
        let states = if separate { "('new', 'downloaded')" } else { "('new')" };
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE state IN {states} AND preview = 0
               AND (favorite = 1 OR id IN (SELECT track_id FROM playlist_tracks))
             ORDER BY favorite DESC, COALESCE(fav_at, added_at) DESC, state = 'downloaded' DESC LIMIT 1"
        );
        Ok(self.query(&sql, [])?.into_iter().next())
    }

    /// After a crash or quit mid-job, unfinished work is retried.
    pub fn reset_interrupted(&self) -> Result<()> {
        self.conn.execute("UPDATE tracks SET state = 'new' WHERE state = 'downloading'", [])?;
        self.conn.execute("UPDATE tracks SET state = 'downloaded' WHERE state = 'separating'", [])?;
        Ok(())
    }

    pub fn retry_errors(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET state = CASE WHEN audio IS NULL THEN 'new' ELSE 'downloaded' END, error = NULL WHERE state = 'error'",
            [],
        )?;
        Ok(())
    }

    /// Failures that look like the network (not "track unavailable") get another chance.
    pub fn retry_network_errors(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET state = CASE WHEN audio IS NULL THEN 'new' ELSE 'downloaded' END, error = NULL
             WHERE state = 'error' AND (error LIKE '%недоступ%' OR error LIKE '%timed out%' OR error LIKE '%connect%' OR error LIKE '%сервис отдал пустой%')",
            [],
        )?;
        Ok(())
    }

    /// Previews were all that was available before; after signing in they can become full tracks.
    pub fn reset_previews(&self) -> Result<()> {
        self.conn.execute("UPDATE tracks SET state = 'new', preview = 0, audio = NULL WHERE preview = 1", [])?;
        Ok(())
    }

    pub fn counts(&self) -> Result<(i64, i64, i64)> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*), SUM(state = 'ready'), SUM(state IN ('new','downloading','downloaded','separating'))
             FROM tracks WHERE favorite = 1 OR id IN (SELECT track_id FROM playlist_tracks)",
            [],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), r.get::<_, Option<i64>>(2)?.unwrap_or(0))),
        )?)
    }

    /* ───── playlists ───── */

    pub fn playlists(&self) -> Result<Vec<Playlist>> {
        let mut statement = self.conn.prepare(
            "SELECT p.id, p.name, COUNT(pt.track_id), SUM(t.state = 'ready') FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             LEFT JOIN tracks t ON t.id = pt.track_id
             GROUP BY p.id ORDER BY p.created_at DESC",
        )?;
        let rows: Vec<(i64, String, i64, i64)> = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0))))?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::new();
        for (id, name, count, ready) in rows {
            let covers = self
                .playlist_tracks(id)?
                .into_iter()
                .filter_map(|t| t.track.cover)
                .fold(Vec::<String>::new(), |mut acc, c| {
                    if !acc.contains(&c) && acc.len() < 4 {
                        acc.push(c);
                    }
                    acc
                });
            out.push(Playlist { id, name, count, covers, ready });
        }
        Ok(out)
    }

    pub fn create_playlist(&self, name: &str) -> Result<i64> {
        self.conn.execute("INSERT INTO playlists (name, created_at) VALUES (?, ?)", params![name, now()])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn rename_playlist(&self, id: i64, name: &str) -> Result<()> {
        self.conn.execute("UPDATE playlists SET name = ? WHERE id = ?", params![name, id])?;
        Ok(())
    }

    pub fn delete_playlist(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM playlists WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn playlist_add(&self, playlist: i64, track: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_tracks WHERE playlist_id = ?1))",
            params![playlist, track],
        )?;
        Ok(())
    }

    pub fn playlist_remove(&self, playlist: i64, track: &str) -> Result<()> {
        self.conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?", params![playlist, track])?;
        Ok(())
    }

    pub fn playlist_reorder(&self, playlist: i64, ids: &[String]) -> Result<()> {
        for (position, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?",
                params![position as i64, playlist, id],
            )?;
        }
        Ok(())
    }

    pub fn playlist_tracks(&self, playlist: i64) -> Result<Vec<LibraryTrack>> {
        let columns = TRACK_COLUMNS.split(", ").map(|c| format!("t.{c}")).collect::<Vec<_>>().join(", ");
        self.query(
            &format!(
                "SELECT {columns} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ? ORDER BY pt.position"
            ),
            [playlist],
        )
    }

    pub fn track_playlists(&self, track: &str) -> Result<Vec<i64>> {
        let mut statement = self.conn.prepare("SELECT playlist_id FROM playlist_tracks WHERE track_id = ?")?;
        let rows = statement.query_map([track], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /* ───── settings ───── */

    pub fn setting(&self, key: &str) -> Option<String> {
        self.conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )?,
            None => self.conn.execute("DELETE FROM settings WHERE key = ?", [key])?,
        };
        Ok(())
    }
}

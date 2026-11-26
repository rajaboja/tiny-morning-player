import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS episodes (
    slug TEXT PRIMARY KEY,
    mixcloud_key TEXT NOT NULL,
    mixcloud_url TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT,
    audio_length INTEGER NOT NULL DEFAULT 0,
    picture TEXT,
    created_time TEXT,
    spinitron_id TEXT,
    spinitron_url TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodes(date DESC, created_time DESC)`,
  `CREATE TABLE IF NOT EXISTS episode_tracklists (
    slug TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    spinitron_id TEXT,
    spinitron_url TEXT,
    description TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tracks (
    episode_slug TEXT NOT NULL,
    position INTEGER NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    song TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    isrc TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    offset_seconds INTEGER NOT NULL DEFAULT 0,
    artwork TEXT,
    PRIMARY KEY (episode_slug, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_song ON tracks(song)`,
  `CREATE TABLE IF NOT EXISTS favorites (
    episode_slug TEXT NOT NULL,
    track_index INTEGER NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    song TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    offset_seconds INTEGER NOT NULL DEFAULT 0,
    artwork TEXT,
    episode_name TEXT NOT NULL DEFAULT '',
    episode_date TEXT,
    mixcloud_key TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (episode_slug, track_index)
  )`,
  `CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    episode_slug TEXT NOT NULL,
    track_index INTEGER NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    song TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    offset_seconds INTEGER NOT NULL DEFAULT 0,
    artwork TEXT,
    episode_name TEXT NOT NULL DEFAULT '',
    episode_date TEXT,
    mixcloud_key TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(list_id, episode_slug, track_index),
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position)`,
];

export function resolveDbConfig(options = {}) {
  const rawUrl = options.url ?? process.env.TURSO_DATABASE_URL ?? '';
  if (rawUrl) {
    return {
      url: rawUrl,
      authToken: options.authToken ?? process.env.TURSO_AUTH_TOKEN ?? undefined,
    };
  }
  const dbPath = path.resolve(
    options.dbPath ?? process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'tiny-morning-player.db'),
  );
  return {
    url: `file:${dbPath}`,
    authToken: undefined,
  };
}

function mapEpisodeRow(row) {
  return {
    mixcloudKey: row.mixcloud_key,
    mixcloudUrl: row.mixcloud_url,
    name: row.name,
    slug: row.slug,
    date: row.date || null,
    audioLength: Number(row.audio_length) || 0,
    picture: row.picture || null,
    createdTime: row.created_time || null,
    spinitronId: row.spinitron_id || null,
    spinitronUrl: row.spinitron_url || null,
  };
}

function mapTrackRow(row) {
  const track = {
    artist: row.artist || '',
    song: row.song || '',
    album: row.album || '',
    time: row.time || '',
    offsetSeconds: Number(row.offset_seconds) || 0,
    artwork: row.artwork || null,
  };
  if (row.isrc) track.isrc = row.isrc;
  return track;
}

function mapSavedTrackRow(row) {
  return {
    episodeSlug: row.episode_slug,
    trackIndex: Number(row.track_index),
    artist: row.artist || '',
    song: row.song || '',
    album: row.album || '',
    time: row.time || '',
    offsetSeconds: Number(row.offset_seconds) || 0,
    artwork: row.artwork || null,
    episodeName: row.episode_name || '',
    episodeDate: row.episode_date || null,
    mixcloudKey: row.mixcloud_key || '',
    createdAt: Number(row.created_at) || 0,
  };
}

function generateListId() {
  return crypto.randomBytes(6).toString('base64url');
}

export function createStore(options = {}) {
  const config = resolveDbConfig(options);
  let client = null;
  let initPromise = null;

  async function ensureInit() {
    if (!initPromise) {
      initPromise = (async () => {
        if (config.url.startsWith('file:') && config.url !== 'file::memory:') {
          const filePath = config.url.slice('file:'.length);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
        }
        client = createClient(config.authToken ? { url: config.url, authToken: config.authToken } : { url: config.url });
        await client.execute('PRAGMA foreign_keys = ON').catch(() => {});
        await client.batch(SCHEMA_STATEMENTS, 'write');
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
    return client;
  }

  return {
    config,

    async init() {
      await ensureInit();
    },

    async close() {
      if (client) {
        client.close();
        client = null;
        initPromise = null;
      }
    },

    async getEpisodesSyncedAt() {
      const db = await ensureInit();
      const res = await db.execute({
        sql: `SELECT value FROM meta WHERE key = 'episodes_last_synced_at'`,
        args: [],
      });
      return res.rows.length ? Number(res.rows[0].value) || 0 : 0;
    },

    async getEpisodes() {
      const db = await ensureInit();
      const res = await db.execute(`
        SELECT slug, mixcloud_key, mixcloud_url, name, date, audio_length,
               picture, created_time, spinitron_id, spinitron_url
        FROM episodes
        ORDER BY COALESCE(date, '') DESC, COALESCE(created_time, '') DESC, slug ASC
      `);
      return res.rows.map(mapEpisodeRow);
    },

    async saveEpisodes(episodes, syncedAt = Date.now()) {
      const db = await ensureInit();
      const statements = [];
      for (const ep of episodes) {
        if (!ep?.slug) continue;
        statements.push({
          sql: `
            INSERT INTO episodes (
              slug, mixcloud_key, mixcloud_url, name, date, audio_length,
              picture, created_time, spinitron_id, spinitron_url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              mixcloud_key = excluded.mixcloud_key,
              mixcloud_url = excluded.mixcloud_url,
              name = excluded.name,
              date = COALESCE(excluded.date, episodes.date),
              audio_length = CASE WHEN excluded.audio_length > 0 THEN excluded.audio_length ELSE episodes.audio_length END,
              picture = COALESCE(excluded.picture, episodes.picture),
              created_time = COALESCE(excluded.created_time, episodes.created_time),
              spinitron_id = COALESCE(excluded.spinitron_id, episodes.spinitron_id),
              spinitron_url = COALESCE(excluded.spinitron_url, episodes.spinitron_url),
              updated_at = excluded.updated_at
          `,
          args: [
            ep.slug,
            ep.mixcloudKey || '',
            ep.mixcloudUrl || '',
            ep.name || '',
            ep.date || null,
            Number(ep.audioLength) || 0,
            ep.picture || null,
            ep.createdTime || null,
            ep.spinitronId || null,
            ep.spinitronUrl || null,
            syncedAt,
          ],
        });
      }
      statements.push({
        sql: `
          INSERT INTO meta (key, value) VALUES ('episodes_last_synced_at', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        args: [String(syncedAt)],
      });
      await db.batch(statements, 'write');
    },

    async getEpisodeTracks(slug) {
      const db = await ensureInit();
      const metaRes = await db.execute({
        sql: `
          SELECT slug, source, spinitron_id, spinitron_url, description, fetched_at
          FROM episode_tracklists
          WHERE slug = ?
        `,
        args: [slug],
      });
      if (!metaRes.rows.length) return null;
      const metaRow = metaRes.rows[0];
      const tracksRes = await db.execute({
        sql: `
          SELECT artist, song, album, isrc, time, offset_seconds, artwork
          FROM tracks
          WHERE episode_slug = ?
          ORDER BY position ASC
        `,
        args: [slug],
      });
      return {
        source: metaRow.source,
        slug: metaRow.slug,
        spinitronId: metaRow.spinitron_id || null,
        spinitronUrl: metaRow.spinitron_url || null,
        description: metaRow.description || '',
        tracks: tracksRes.rows.map(mapTrackRow),
        fetchedAt: Number(metaRow.fetched_at) || 0,
      };
    },

    async saveEpisodeTracks(slug, payload, fetchedAt = Date.now()) {
      const db = await ensureInit();
      const incomingTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
      const existing = await this.getEpisodeTracks(slug);

      // Never wipe a non-empty archived tracklist with an empty upstream response.
      const keepExistingTracks = existing && existing.tracks.length > 0 && incomingTracks.length === 0;
      const statements = [
        {
          sql: `
            INSERT INTO episode_tracklists (
              slug, source, spinitron_id, spinitron_url, description, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              source = CASE WHEN ? THEN episode_tracklists.source ELSE excluded.source END,
              spinitron_id = COALESCE(excluded.spinitron_id, episode_tracklists.spinitron_id),
              spinitron_url = COALESCE(excluded.spinitron_url, episode_tracklists.spinitron_url),
              description = CASE WHEN excluded.description != '' THEN excluded.description ELSE episode_tracklists.description END,
              fetched_at = excluded.fetched_at
          `,
          args: [
            slug,
            payload.source || 'spinitron',
            payload.spinitronId || null,
            payload.spinitronUrl || null,
            payload.description || '',
            fetchedAt,
            keepExistingTracks ? 1 : 0,
          ],
        },
      ];

      if (!keepExistingTracks) {
        statements.push({
          sql: `DELETE FROM tracks WHERE episode_slug = ?`,
          args: [slug],
        });
        for (let i = 0; i < incomingTracks.length; i++) {
          const t = incomingTracks[i];
          statements.push({
            sql: `
              INSERT INTO tracks (
                episode_slug, position, artist, song, album, isrc, time, offset_seconds, artwork
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              slug,
              i,
              t.artist || '',
              t.song || '',
              t.album || '',
              t.isrc || '',
              t.time || '',
              Math.max(0, Number(t.offsetSeconds) || 0),
              t.artwork || null,
            ],
          });
        }
      }

      await db.batch(statements, 'write');
    },

    async listFavorites() {
      const db = await ensureInit();
      const res = await db.execute(`
        SELECT episode_slug, track_index, artist, song, album, time, offset_seconds,
               artwork, episode_name, episode_date, mixcloud_key, created_at
        FROM favorites
        ORDER BY created_at DESC, episode_slug ASC, track_index ASC
      `);
      return res.rows.map(mapSavedTrackRow);
    },

    async addFavorite(item, createdAt = Date.now()) {
      const db = await ensureInit();
      await db.execute({
        sql: `
          INSERT INTO favorites (
            episode_slug, track_index, artist, song, album, time, offset_seconds,
            artwork, episode_name, episode_date, mixcloud_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(episode_slug, track_index) DO UPDATE SET
            artist = excluded.artist,
            song = excluded.song,
            album = excluded.album,
            time = excluded.time,
            offset_seconds = excluded.offset_seconds,
            artwork = excluded.artwork,
            episode_name = excluded.episode_name,
            episode_date = excluded.episode_date,
            mixcloud_key = excluded.mixcloud_key
        `,
        args: [
          item.episodeSlug,
          item.trackIndex,
          item.artist || '',
          item.song || '',
          item.album || '',
          item.time || '',
          Math.max(0, Number(item.offsetSeconds) || 0),
          item.artwork || null,
          item.episodeName || '',
          item.episodeDate || null,
          item.mixcloudKey || '',
          createdAt,
        ],
      });
      const res = await db.execute({
        sql: `
          SELECT episode_slug, track_index, artist, song, album, time, offset_seconds,
                 artwork, episode_name, episode_date, mixcloud_key, created_at
          FROM favorites
          WHERE episode_slug = ? AND track_index = ?
        `,
        args: [item.episodeSlug, item.trackIndex],
      });
      return mapSavedTrackRow(res.rows[0]);
    },

    async removeFavorite(episodeSlug, trackIndex) {
      const db = await ensureInit();
      const res = await db.execute({
        sql: `DELETE FROM favorites WHERE episode_slug = ? AND track_index = ?`,
        args: [episodeSlug, trackIndex],
      });
      return (res.rowsAffected || 0) > 0;
    },

    async getLists() {
      const db = await ensureInit();
      const res = await db.execute(`
        SELECT l.id, l.name, l.description, l.created_at, l.updated_at,
               COUNT(li.id) AS item_count
        FROM lists l
        LEFT JOIN list_items li ON li.list_id = l.id
        GROUP BY l.id
        ORDER BY l.updated_at DESC, l.created_at DESC
      `);
      return res.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description || '',
        itemCount: Number(row.item_count) || 0,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
      }));
    },

    async createList({ name, description = '' }, now = Date.now()) {
      const db = await ensureInit();
      const id = generateListId();
      await db.execute({
        sql: `
          INSERT INTO lists (id, name, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [id, name, description, now, now],
      });
      return {
        id,
        name,
        description,
        itemCount: 0,
        items: [],
        createdAt: now,
        updatedAt: now,
      };
    },

    async getList(id) {
      const db = await ensureInit();
      const listRes = await db.execute({
        sql: `SELECT id, name, description, created_at, updated_at FROM lists WHERE id = ?`,
        args: [id],
      });
      if (!listRes.rows.length) return null;
      const row = listRes.rows[0];
      const itemsRes = await db.execute({
        sql: `
          SELECT episode_slug, track_index, artist, song, album, time, offset_seconds,
                 artwork, episode_name, episode_date, mixcloud_key, created_at
          FROM list_items
          WHERE list_id = ?
          ORDER BY position ASC, id ASC
        `,
        args: [id],
      });
      const items = itemsRes.rows.map(mapSavedTrackRow);
      return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        itemCount: items.length,
        items,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
      };
    },

    async updateList(id, { name, description }, now = Date.now()) {
      const db = await ensureInit();
      const existing = await this.getList(id);
      if (!existing) return null;
      const nextName = name !== undefined ? name : existing.name;
      const nextDescription = description !== undefined ? description : existing.description;
      await db.execute({
        sql: `UPDATE lists SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
        args: [nextName, nextDescription, now, id],
      });
      return {
        ...existing,
        name: nextName,
        description: nextDescription,
        updatedAt: now,
      };
    },

    async deleteList(id) {
      const db = await ensureInit();
      const existing = await db.execute({
        sql: `SELECT id FROM lists WHERE id = ?`,
        args: [id],
      });
      if (!existing.rows.length) return false;
      await db.batch(
        [
          { sql: `DELETE FROM list_items WHERE list_id = ?`, args: [id] },
          { sql: `DELETE FROM lists WHERE id = ?`, args: [id] },
        ],
        'write',
      );
      return true;
    },

    async addListItem(listId, item, now = Date.now()) {
      const db = await ensureInit();
      const listRes = await db.execute({
        sql: `SELECT id FROM lists WHERE id = ?`,
        args: [listId],
      });
      if (!listRes.rows.length) return null;

      const posRes = await db.execute({
        sql: `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM list_items WHERE list_id = ?`,
        args: [listId],
      });
      const nextPos = Number(posRes.rows[0].next_pos) || 0;

      await db.batch(
        [
          {
            sql: `
              INSERT INTO list_items (
                list_id, position, episode_slug, track_index, artist, song, album,
                time, offset_seconds, artwork, episode_name, episode_date, mixcloud_key, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(list_id, episode_slug, track_index) DO UPDATE SET
                artist = excluded.artist,
                song = excluded.song,
                album = excluded.album,
                time = excluded.time,
                offset_seconds = excluded.offset_seconds,
                artwork = excluded.artwork,
                episode_name = excluded.episode_name,
                episode_date = excluded.episode_date,
                mixcloud_key = excluded.mixcloud_key
            `,
            args: [
              listId,
              nextPos,
              item.episodeSlug,
              item.trackIndex,
              item.artist || '',
              item.song || '',
              item.album || '',
              item.time || '',
              Math.max(0, Number(item.offsetSeconds) || 0),
              item.artwork || null,
              item.episodeName || '',
              item.episodeDate || null,
              item.mixcloudKey || '',
              now,
            ],
          },
          {
            sql: `UPDATE lists SET updated_at = ? WHERE id = ?`,
            args: [now, listId],
          },
        ],
        'write',
      );

      return this.getList(listId);
    },

    async removeListItem(listId, episodeSlug, trackIndex, now = Date.now()) {
      const db = await ensureInit();
      const listRes = await db.execute({
        sql: `SELECT id FROM lists WHERE id = ?`,
        args: [listId],
      });
      if (!listRes.rows.length) return null;

      const res = await db.execute({
        sql: `DELETE FROM list_items WHERE list_id = ? AND episode_slug = ? AND track_index = ?`,
        args: [listId, episodeSlug, trackIndex],
      });
      if ((res.rowsAffected || 0) > 0) {
        await db.execute({
          sql: `UPDATE lists SET updated_at = ? WHERE id = ?`,
          args: [now, listId],
        });
      }
      return (res.rowsAffected || 0) > 0;
    },
  };
}

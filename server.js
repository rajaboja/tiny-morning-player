import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEpisodes, getEpisodeTracks, getTracklist } from './lib/sources.js';
import { createStore } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9-]+$/i;
const LIST_ID_RE = /^[a-z0-9_-]{1,64}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Metadata lookup timed out')), ms);
    }),
  ]);
}

export function getCanonicalOrigin(req) {
  const rawProto = req.headers['x-forwarded-proto'];
  const protoCandidate = typeof rawProto === 'string' ? rawProto.split(',')[0].trim().toLowerCase() : '';
  const proto = protoCandidate === 'https' || protoCandidate === 'http' ? protoCandidate : 'http';
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const host = String(rawHost).split(',')[0].trim();
  return `${proto}://${host}`;
}

export function pickPreviewImage(trackArtwork, epPicture) {
  if (trackArtwork && !/\.svg(?:$|\?)/i.test(trackArtwork) && !/\/placeholders\//i.test(trackArtwork)) {
    return trackArtwork;
  }
  return epPicture || null;
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new HttpError(400, 'Empty JSON body');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return parsed;
}

function cleanText(val, maxLen = 300) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function validateSavedTrackInput(body) {
  const episodeSlug = cleanText(body.episodeSlug, 200);
  if (!SLUG_RE.test(episodeSlug)) {
    throw new HttpError(400, 'Invalid episodeSlug');
  }
  const trackIndex = Number(body.trackIndex);
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    throw new HttpError(400, 'Invalid trackIndex');
  }
  const offsetSeconds = Number(body.offsetSeconds ?? 0);
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
    throw new HttpError(400, 'Invalid offsetSeconds');
  }
  return {
    episodeSlug,
    trackIndex,
    artist: cleanText(body.artist, 300),
    song: cleanText(body.song, 300),
    album: cleanText(body.album, 300),
    time: cleanText(body.time, 40),
    offsetSeconds: Math.floor(offsetSeconds),
    artwork: body.artwork ? cleanText(body.artwork, 1000) : null,
    episodeName: cleanText(body.episodeName, 300),
    episodeDate: body.episodeDate ? cleanText(body.episodeDate, 32) : null,
    mixcloudKey: cleanText(body.mixcloudKey, 300),
  };
}

function validateListInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) throw new HttpError(400, 'List name is required');
    out.name = name;
  }
  if (body.description !== undefined) {
    out.description = cleanText(body.description, 500);
  }
  return out;
}

async function resolveShareMeta(req, url, deps) {
  const origin = getCanonicalOrigin(req);
  const listId = url.searchParams.get('list')?.trim() || '';
  if (listId) {
    if (!LIST_ID_RE.test(listId)) return null;
    const list = await withTimeout(deps.store.getList(listId), deps.metaTimeoutMs);
    if (!list) return null;
    const countLabel = `${list.items.length} ${list.items.length === 1 ? 'track' : 'tracks'}`;
    const descParts = [countLabel];
    if (list.description) descParts.push(list.description);
    descParts.push('My Tiny Morning Show');
    let image = null;
    for (const item of list.items) {
      const candidate = pickPreviewImage(item.artwork, null);
      if (candidate) {
        image = candidate;
        break;
      }
    }
    const canonicalParams = new URLSearchParams({ list: list.id });
    return {
      title: `${list.name} · My Tiny Morning Show`,
      ogTitle: list.name,
      description: descParts.join(' · '),
      image,
      type: 'music.playlist',
      url: `${origin}/?${canonicalParams.toString()}`,
    };
  }

  const epSlug = url.searchParams.get('ep')?.trim() || '';
  if (!SLUG_RE.test(epSlug)) return null;

  const episodes = await withTimeout(deps.getEpisodes(), deps.metaTimeoutMs);
  const ep = episodes.find((item) => item.slug === epSlug);
  if (!ep) return null;

  const trackRaw = url.searchParams.get('track')?.trim() || '';
  const tRaw = url.searchParams.get('t')?.trim() || '';
  const trackNum = /^\d+$/.test(trackRaw) ? Number(trackRaw) : null;
  const seconds = /^\d+$/.test(tRaw) ? Number(tRaw) : null;

  if ((trackNum && trackNum >= 1) || seconds !== null) {
    const data = await withTimeout(deps.getEpisodeTracks(ep.slug, ep.spinitronId), deps.metaTimeoutMs).catch(() => null);
    const tracks = data?.tracks || [];
    let trackIdx = null;
    if (trackNum && trackNum >= 1 && trackNum <= tracks.length) {
      trackIdx = trackNum - 1;
    } else if (seconds !== null && tracks.length) {
      trackIdx = 0;
      for (let i = 0; i < tracks.length; i++) {
        if (seconds >= Math.max(0, tracks[i].offsetSeconds || 0)) trackIdx = i;
        else break;
      }
    }
    const track = trackIdx !== null ? tracks[trackIdx] : null;
    if (track) {
      const label = track.artist && track.song
        ? `${track.artist} — ${track.song}`
        : (track.song || track.artist || ep.name);
      const descParts = [`From ${ep.name} (at ${formatDuration(track.offsetSeconds)})`];
      if (track.album) descParts.push(track.album);
      const canonicalParams = new URLSearchParams({ ep: ep.slug, track: String(trackIdx + 1) });
      return {
        title: `${label} · My Tiny Morning Show`,
        ogTitle: label,
        description: descParts.join(' · '),
        image: pickPreviewImage(track.artwork, ep.picture),
        type: 'music.song',
        url: `${origin}/?${canonicalParams.toString()}`,
      };
    }
  }

  const canonicalParams = new URLSearchParams({ ep: ep.slug });
  return {
    title: `${ep.name} · My Tiny Morning Show`,
    ogTitle: ep.name,
    description: 'My Tiny Morning Show · Bob Boilen · WOWD 94.3 FM',
    image: ep.picture || null,
    type: 'website',
    url: `${origin}/?${canonicalParams.toString()}`,
  };
}

export function injectShareMeta(html, meta) {
  const tags = [
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:site_name" content="My Tiny Morning Show">`,
    `<meta property="og:type" content="${escapeHtml(meta.type)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}">` : '',
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
    meta.image ? `<meta name="twitter:image" content="${escapeHtml(meta.image)}">` : '',
  ].filter(Boolean).join('\n  ');

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(meta.title)}</title>`)
    .replace(/<\/head>/i, () => `  ${tags}\n</head>`);
}

async function serveIndexWithMeta(req, res, url, deps) {
  let html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const meta = await resolveShareMeta(req, url, deps).catch(() => null);
  if (meta) {
    html = injectShareMeta(html, meta);
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES['.html'],
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

async function serveStatic(res, pathname) {
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fullPath = path.resolve(PUBLIC_DIR, relPath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

export function createServer(overrides = {}) {
  const ownsStore = !overrides.store;
  const store = overrides.store ?? createStore();
  const deps = {
    store,
    getEpisodes: (refresh) => getEpisodes(refresh, store),
    getEpisodeTracks: (slug, spinitronId) => getEpisodeTracks(slug, spinitronId, store),
    getTracklist,
    metaTimeoutMs: 3000,
    ...overrides,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/api/episodes') {
        const refresh = url.searchParams.get('refresh') === '1';
        const episodes = await deps.getEpisodes(refresh);
        return sendJson(res, 200, { episodes });
      }

      const episodeTracksMatch = pathname.match(/^\/api\/episodes\/([a-z0-9-]+)\/tracks$/i);
      if (req.method === 'GET' && episodeTracksMatch) {
        const spinitronId = url.searchParams.get('spinitronId');
        const data = await deps.getEpisodeTracks(episodeTracksMatch[1], spinitronId);
        return sendJson(res, 200, data);
      }

      const trackMatch = pathname.match(/^\/api\/tracks\/(\d+)$/);
      if (req.method === 'GET' && trackMatch) {
        const data = await deps.getTracklist(trackMatch[1]);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/favorites') {
        if (req.method === 'GET') {
          const favorites = await deps.store.listFavorites();
          return sendJson(res, 200, { favorites });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const item = validateSavedTrackInput(body);
          const favorite = await deps.store.addFavorite(item);
          return sendJson(res, 201, { favorite });
        }
      }

      const favDeleteMatch = pathname.match(/^\/api\/favorites\/([a-z0-9-]+)\/(\d+)$/i);
      if (req.method === 'DELETE' && favDeleteMatch) {
        const deleted = await deps.store.removeFavorite(favDeleteMatch[1], Number(favDeleteMatch[2]));
        return sendJson(res, 200, { deleted });
      }

      if (pathname === '/api/lists') {
        if (req.method === 'GET') {
          const lists = await deps.store.getLists();
          return sendJson(res, 200, { lists });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const input = validateListInput(body);
          const list = await deps.store.createList(input);
          return sendJson(res, 201, { list });
        }
      }

      const listItemDeleteMatch = pathname.match(/^\/api\/lists\/([a-z0-9_-]{1,64})\/items\/([a-z0-9-]+)\/(\d+)$/i);
      if (req.method === 'DELETE' && listItemDeleteMatch) {
        const result = await deps.store.removeListItem(
          listItemDeleteMatch[1],
          listItemDeleteMatch[2],
          Number(listItemDeleteMatch[3]),
        );
        if (result === null) return sendJson(res, 404, { error: 'List not found' });
        return sendJson(res, 200, { deleted: result });
      }

      const listItemsMatch = pathname.match(/^\/api\/lists\/([a-z0-9_-]{1,64})\/items$/i);
      if (req.method === 'POST' && listItemsMatch) {
        const body = await readJsonBody(req);
        const item = validateSavedTrackInput(body);
        const list = await deps.store.addListItem(listItemsMatch[1], item);
        if (!list) return sendJson(res, 404, { error: 'List not found' });
        return sendJson(res, 201, { list });
      }

      const listMatch = pathname.match(/^\/api\/lists\/([a-z0-9_-]{1,64})$/i);
      if (listMatch) {
        const listId = listMatch[1];
        if (req.method === 'GET') {
          const list = await deps.store.getList(listId);
          if (!list) return sendJson(res, 404, { error: 'List not found' });
          return sendJson(res, 200, { list });
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const input = validateListInput(body, { partial: true });
          const list = await deps.store.updateList(listId, input);
          if (!list) return sendJson(res, 404, { error: 'List not found' });
          return sendJson(res, 200, { list });
        }
        if (req.method === 'DELETE') {
          const deleted = await deps.store.deleteList(listId);
          if (!deleted) return sendJson(res, 404, { error: 'List not found' });
          return sendJson(res, 200, { deleted: true });
        }
      }

      if (
        req.method === 'GET' &&
        (pathname === '/' || pathname === '/index.html') &&
        (url.searchParams.has('ep') || url.searchParams.has('list'))
      ) {
        return await serveIndexWithMeta(req, res, url, deps);
      }

      if (req.method === 'GET') {
        return await serveStatic(res, pathname);
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message });
      }
      console.error(err);
      sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  });

  server.store = store;
  if (ownsStore) {
    server.on('close', () => {
      store.close().catch(() => {});
    });
  }

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tiny Morning Player listening on http://0.0.0.0:${PORT}`);
  });
}

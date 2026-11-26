import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEpisodes, getEpisodeTracks, getTracklist } from './lib/sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

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

async function resolveShareMeta(req, url, deps) {
  const epSlug = url.searchParams.get('ep')?.trim() || '';
  if (!/^[a-z0-9-]+$/i.test(epSlug)) return null;

  const episodes = await withTimeout(deps.getEpisodes(), deps.metaTimeoutMs);
  const ep = episodes.find((item) => item.slug === epSlug);
  if (!ep) return null;

  const origin = getCanonicalOrigin(req);
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
  const deps = {
    getEpisodes,
    getEpisodeTracks,
    getTracklist,
    metaTimeoutMs: 3000,
    ...overrides,
  };

  return http.createServer(async (req, res) => {
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

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html') && url.searchParams.has('ep')) {
        return await serveIndexWithMeta(req, res, url, deps);
      }

      if (req.method === 'GET') {
        return await serveStatic(res, pathname);
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tiny Morning Player listening on http://0.0.0.0:${PORT}`);
  });
}

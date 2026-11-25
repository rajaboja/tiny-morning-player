const MIXCLOUD_API = 'https://api.mixcloud.com/bob-boilen/cloudcasts/?limit=50';
const SPINITRON_SHOW_URL = 'https://spinitron.com/WOWD/show/256073/My-Tiny-Morning-Show?bodyclass=wowd-schedule';
const SPINITRON_PL_BASE = 'https://spinitron.com/WOWD/pl/';

const EPISODES_TTL_MS = 15 * 60 * 1000;
const TRACKS_TTL_MS = 60 * 60 * 1000;

const cache = {
  episodes: { data: null, expiresAt: 0 },
  tracks: new Map(),
};

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\u202f|\u00a0/g, ' ');
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateFromText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[-_]/g, ' ');
  const m1 = cleaned.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (m1) {
    const month = MONTHS[m1[1].toLowerCase()];
    const day = Number(m1[2]);
    const year = Number(m1[3]);
    if (month && day >= 1 && day <= 31) return toIsoDate(year, month, day);
  }
  const m2 = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function parseTimeToMinutes(timeStr) {
  const cleaned = decodeHtml(timeStr).trim();
  const m = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const period = m[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

async function fetchMixcloudEpisodes(maxPages = 3) {
  const items = [];
  let url = MIXCLOUD_API;
  for (let page = 0; page < maxPages && url; page++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'tiny-morning-player/1.0' } });
    if (!res.ok) throw new Error(`Mixcloud API error: ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json.data)) {
      for (const ep of json.data) {
        const date = parseDateFromText(ep.name) || parseDateFromText(ep.slug) || (ep.created_time ? ep.created_time.slice(0, 10) : null);
        items.push({
          mixcloudKey: ep.key,
          mixcloudUrl: ep.url,
          name: ep.name,
          slug: ep.slug,
          date,
          audioLength: ep.audio_length || 0,
          picture: ep.pictures?.large || ep.pictures?.medium || null,
          createdTime: ep.created_time,
        });
      }
    }
    url = json.paging?.next || null;
  }
  return items;
}

async function fetchSpinitronEpisodes(maxPages = 3) {
  const byId = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? SPINITRON_SHOW_URL : `${SPINITRON_SHOW_URL}&page=${page}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'tiny-morning-player/1.0' } });
    if (!res.ok) break;
    const html = await res.text();
    const blockRe = /href="\/WOWD\/pl\/(\d+)\/[^"]*"[\s\S]{0,600}?\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/gi;
    let match;
    let foundOnPage = 0;
    while ((match = blockRe.exec(html)) !== null) {
      const playlistId = match[1];
      const date = parseDateFromText(match[2]);
      if (playlistId && date && !byId.has(playlistId)) {
        byId.set(playlistId, {
          spinitronId: playlistId,
          spinitronUrl: `${SPINITRON_PL_BASE}${playlistId}/My-Tiny-Morning-Show`,
          date,
        });
        foundOnPage++;
      }
    }
    if (foundOnPage === 0) break;
  }
  return Array.from(byId.values());
}

export async function getEpisodes(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.episodes.data && cache.episodes.expiresAt > now) {
    return cache.episodes.data;
  }

  const [mixcloud, spinitron] = await Promise.all([
    fetchMixcloudEpisodes(3),
    fetchSpinitronEpisodes(3),
  ]);

  const spinitronByDate = new Map();
  for (const sp of spinitron) {
    if (sp.date && !spinitronByDate.has(sp.date)) {
      spinitronByDate.set(sp.date, sp);
    }
  }

  const matched = mixcloud.map((mc) => {
    const sp = mc.date ? spinitronByDate.get(mc.date) : null;
    return {
      ...mc,
      spinitronId: sp?.spinitronId || null,
      spinitronUrl: sp?.spinitronUrl || null,
    };
  });

  cache.episodes = { data: matched, expiresAt: now + EPISODES_TTL_MS };
  return matched;
}

export async function getTracklist(playlistId) {
  if (!/^\d+$/.test(String(playlistId))) {
    throw new Error('Invalid playlist ID');
  }

  const now = Date.now();
  const cached = cache.tracks.get(playlistId);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const url = `${SPINITRON_PL_BASE}${playlistId}/My-Tiny-Morning-Show`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tiny-morning-player/1.0' } });
  if (!res.ok) throw new Error(`Spinitron error: ${res.status}`);
  const html = await res.text();

  const startMatch = html.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[–-]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  const showStartMinutes = startMatch ? parseTimeToMinutes(startMatch[1]) : 8 * 60;

  const descMatch = html.match(/<div class="description">([\s\S]*?)<\/div>/i);
  const description = descMatch
    ? decodeHtml(descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    : '';

  const tracks = [];
  const rowRe = /<tr[^>]*class="[^"]*spin-item[^"]*"[^>]*data-spin="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    let spinData = {};
    try {
      spinData = JSON.parse(decodeHtml(rowMatch[1]));
    } catch {
      continue;
    }

    const rowHtml = rowMatch[2];
    const timeMatch = rowHtml.match(/<td class="spin-time">[\s\S]*?(\d{1,2}:\d{2}[\s\u202f\u00a0]*(?:AM|PM))/i);
    const timeLabel = timeMatch ? decodeHtml(timeMatch[1]).replace(/\s+/g, ' ').trim() : '';
    const spinMinutes = parseTimeToMinutes(timeLabel);

    let offsetSeconds = 0;
    if (spinMinutes !== null && showStartMinutes !== null) {
      let diff = spinMinutes - showStartMinutes;
      if (diff < -60) diff += 24 * 60;
      offsetSeconds = Math.max(0, diff * 60);
    }

    const artMatch = rowHtml.match(/<td class="spin-art">[\s\S]*?<img[^>]+src="([^"]+)"/i);
    const artwork = artMatch ? artMatch[1] : null;

    tracks.push({
      artist: spinData.a || '',
      song: spinData.s || '',
      album: spinData.r || '',
      isrc: spinData.i || '',
      time: timeLabel,
      offsetSeconds,
      artwork,
    });
  }

  const result = {
    playlistId,
    spinitronUrl: url,
    showStartTime: startMatch ? decodeHtml(startMatch[1]) : '8:00 AM',
    description,
    tracks,
  };

  cache.tracks.set(playlistId, { data: result, expiresAt: now + TRACKS_TTL_MS });
  return result;
}

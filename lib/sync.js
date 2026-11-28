import {
  fetchMixcloudEpisodes,
  fetchSpinitronEpisodes,
  fetchEpisodeTracks,
} from './sources.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveInt(val, fallback) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseSyncArgs(argv = []) {
  const opts = {
    full: false,
    requireRemote: false,
    maxPages: 3,
    recentDays: 30,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--require-remote') {
      opts.requireRemote = true;
    } else if (arg.startsWith('--max-pages=')) {
      opts.maxPages = parsePositiveInt(arg.slice('--max-pages='.length), opts.maxPages);
    } else if (arg === '--max-pages' && i + 1 < argv.length) {
      opts.maxPages = parsePositiveInt(argv[++i], opts.maxPages);
    } else if (arg.startsWith('--recent-days=')) {
      opts.recentDays = parsePositiveInt(arg.slice('--recent-days='.length), opts.recentDays);
    } else if (arg === '--recent-days' && i + 1 < argv.length) {
      opts.recentDays = parsePositiveInt(argv[++i], opts.recentDays);
    }
  }

  return opts;
}

function isRecentEpisode(episode, now, recentDays) {
  const raw = episode?.date
    ? `${episode.date}T00:00:00Z`
    : episode?.createdTime || null;
  if (!raw) return false;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return false;
  return now - ts <= recentDays * DAY_MS;
}

export function shouldSyncEpisodeTracks(episode, trackState, { full = false, now = Date.now(), recentDays = 30 } = {}) {
  if (full) return true;
  if (!trackState) return true;
  if (episode.spinitronId && !trackState.spinitronId && trackState.source === 'mixcloud') {
    return true;
  }
  if (trackState.trackCount === 0 && isRecentEpisode(episode, now, recentDays)) {
    return true;
  }
  return false;
}

function hasEpisodeChanges(existing, incoming) {
  if (!existing) return true;
  if (incoming.name !== existing.name) return true;
  if (incoming.mixcloudKey !== existing.mixcloudKey) return true;
  if (incoming.mixcloudUrl !== existing.mixcloudUrl) return true;
  if (incoming.date && incoming.date !== existing.date) return true;
  if (incoming.audioLength > 0 && incoming.audioLength !== existing.audioLength) return true;
  if (incoming.picture && incoming.picture !== existing.picture) return true;
  if (incoming.createdTime && incoming.createdTime !== existing.createdTime) return true;
  if (incoming.spinitronId && incoming.spinitronId !== existing.spinitronId) return true;
  if (incoming.spinitronUrl && incoming.spinitronUrl !== existing.spinitronUrl) return true;
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncDatabase(store, options = {}) {
  const {
    full = false,
    maxPages = 3,
    recentDays = 30,
    delayMs = 150,
    now = Date.now(),
    logger = console,
    deps = {},
  } = options;

  const fetchMc = deps.fetchMixcloudEpisodes ?? fetchMixcloudEpisodes;
  const fetchSp = deps.fetchSpinitronEpisodes ?? fetchSpinitronEpisodes;
  const fetchTracks = deps.fetchEpisodeTracks ?? fetchEpisodeTracks;
  const sleep = deps.sleep ?? defaultSleep;

  const existingEpisodes = await store.getEpisodes();
  const existingBySlug = new Map(existingEpisodes.map((ep) => [ep.slug, ep]));
  const knownSlugs = new Set(existingBySlug.keys());

  const mixcloudEpisodes = await fetchMc({
    maxPages,
    knownSlugs: full ? null : knownSlugs,
  });

  const mcBySlug = new Map(mixcloudEpisodes.map((ep) => [ep.slug, ep]));

  const candidatesNeedingSpinitron = [];
  for (const ep of mixcloudEpisodes) {
    const prev = existingBySlug.get(ep.slug);
    if (full || !prev || (!prev.spinitronId && isRecentEpisode(ep, now, recentDays))) {
      if (ep.date) candidatesNeedingSpinitron.push(ep);
    }
  }
  for (const prev of existingEpisodes) {
    if (!mcBySlug.has(prev.slug) && !prev.spinitronId && isRecentEpisode(prev, now, recentDays) && prev.date) {
      candidatesNeedingSpinitron.push(prev);
    }
  }

  let spinitronFetched = false;
  const spinitronByDate = new Map();
  if (full || candidatesNeedingSpinitron.length > 0) {
    spinitronFetched = true;
    let stopBeforeDate = null;
    if (!full) {
      for (const ep of candidatesNeedingSpinitron) {
        if (!stopBeforeDate || ep.date < stopBeforeDate) {
          stopBeforeDate = ep.date;
        }
      }
    }
    try {
      const spEpisodes = await fetchSp({ maxPages, stopBeforeDate });
      for (const sp of spEpisodes) {
        if (sp.date && !spinitronByDate.has(sp.date)) {
          spinitronByDate.set(sp.date, sp);
        }
      }
    } catch (err) {
      logger.warn?.(`Spinitron episode index fetch failed: ${err.message}`);
    }
  }

  const episodesToSave = [];
  let newEpisodes = 0;
  let updatedEpisodes = 0;

  for (const mc of mixcloudEpisodes) {
    const prev = existingBySlug.get(mc.slug);
    const sp = mc.date ? spinitronByDate.get(mc.date) : null;
    const merged = {
      ...mc,
      spinitronId: sp?.spinitronId || prev?.spinitronId || null,
      spinitronUrl: sp?.spinitronUrl || prev?.spinitronUrl || null,
    };
    if (!prev) {
      newEpisodes++;
      episodesToSave.push(merged);
    } else if (full || hasEpisodeChanges(prev, merged)) {
      updatedEpisodes++;
      episodesToSave.push(merged);
    }
  }

  for (const prev of existingEpisodes) {
    if (mcBySlug.has(prev.slug) || prev.spinitronId || !prev.date) continue;
    const sp = spinitronByDate.get(prev.date);
    if (sp) {
      updatedEpisodes++;
      episodesToSave.push({
        ...prev,
        spinitronId: sp.spinitronId,
        spinitronUrl: sp.spinitronUrl,
      });
    }
  }

  await store.saveEpisodes(episodesToSave, now);

  const allEpisodes = await store.getEpisodes();
  const trackStates = await store.getTracklistSyncStates();
  const toFetch = allEpisodes.filter((ep) =>
    shouldSyncEpisodeTracks(ep, trackStates.get(ep.slug), { full, now, recentDays }),
  );

  let tracksFetched = 0;
  const errors = [];

  for (let i = 0; i < toFetch.length; i++) {
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
    const ep = toFetch[i];
    try {
      const payload = await fetchTracks(ep.slug, ep.spinitronId);
      await store.saveEpisodeTracks(ep.slug, payload, now);
      tracksFetched++;
    } catch (err) {
      errors.push({ slug: ep.slug, message: err.message });
      logger.warn?.(`Failed to sync tracklist for ${ep.slug}: ${err.message}`);
    }
  }

  return {
    mode: full ? 'full' : 'incremental',
    episodesSeen: mixcloudEpisodes.length,
    newEpisodes,
    updatedEpisodes,
    spinitronFetched,
    tracksAttempted: toFetch.length,
    tracksFetched,
    tracksSkipped: allEpisodes.length - toFetch.length,
    errors,
  };
}

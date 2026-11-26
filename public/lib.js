export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatEpisodeLength(seconds) {
  if (!seconds) return '';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function formatTrackLabel(track) {
  if (track.artist && track.song) return `${track.artist} — ${track.song}`;
  return track.song || track.artist || 'Track';
}

export function parseDeepLink(search) {
  const params = new URLSearchParams(search);
  const ep = params.get('ep')?.trim() || null;
  const list = params.get('list')?.trim() || null;
  const trackRaw = params.get('track')?.trim() || '';
  const tRaw = params.get('t')?.trim() || '';
  const trackNum = /^\d+$/.test(trackRaw) ? Number(trackRaw) : null;
  const trackIndex = trackNum && trackNum >= 1 ? trackNum - 1 : null;
  const seconds = /^\d+$/.test(tRaw) ? Number(tRaw) : null;
  return { ep, list, trackIndex, seconds };
}

export function buildTrackUrl(origin, epSlug, trackIdx = null) {
  const url = new URL('/', origin);
  if (epSlug) url.searchParams.set('ep', epSlug);
  if (trackIdx !== null && trackIdx >= 0) {
    url.searchParams.set('track', String(trackIdx + 1));
  }
  return url.toString();
}

export function buildListUrl(origin, listId) {
  const url = new URL('/', origin);
  if (listId) url.searchParams.set('list', listId);
  return url.toString();
}

export function makeTrackKey(episodeSlug, trackIndex) {
  return `${episodeSlug}:${trackIndex}`;
}

export function resolveTrackIndexByTime(tracks, seconds, syncOffsetSeconds = 0) {
  if (!tracks.length) return null;
  let idx = 0;
  for (let i = 0; i < tracks.length; i++) {
    const start = Math.max(0, tracks[i].offsetSeconds + syncOffsetSeconds);
    if (seconds >= start) idx = i;
    else break;
  }
  return idx;
}

export function filterTracks(tracks, query) {
  const q = String(query || '').trim().toLowerCase();
  return tracks
    .map((t, idx) => ({ ...t, _idx: idx }))
    .filter((t) => {
      if (!q) return true;
      return (
        (t.song || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q)
      );
    });
}

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

export const SEEK_TOLERANCE_SECONDS = 5;
export const SEEK_RETRY_COOLDOWN_MS = 900;
export const SEEK_MAX_ATTEMPTS = 8;
export const SEEK_WINDOW_MS = 20000;

export function createPendingSeek(mixcloudKey, targetSeconds) {
  const target = Math.max(0, Math.floor(targetSeconds || 0));
  if (!mixcloudKey || target <= 0) return null;
  return {
    mixcloudKey,
    target,
    startedAt: null,
    attempts: 0,
    lastSeekAt: 0,
    nearTargetPos: null,
    nearTargetTicks: 0,
  };
}

export function clampSeekTarget(targetSeconds, duration) {
  const target = Math.max(0, Math.floor(targetSeconds || 0));
  if (typeof duration === 'number' && duration > 0) {
    return Math.min(target, Math.max(0, Math.floor(duration) - 2));
  }
  return target;
}

export function evaluateSeekAttempt(pending, loadedMixcloudKey, now, duration) {
  if (!pending || pending.mixcloudKey !== loadedMixcloudKey) {
    return { action: 'wait', target: null, nextPending: pending };
  }
  const startedAt = pending.startedAt ?? now;
  if (now - startedAt > SEEK_WINDOW_MS || pending.attempts >= SEEK_MAX_ATTEMPTS) {
    return { action: 'clear', target: null, nextPending: null };
  }
  if (pending.lastSeekAt && now - pending.lastSeekAt < SEEK_RETRY_COOLDOWN_MS) {
    return { action: 'wait', target: null, nextPending: { ...pending, startedAt } };
  }
  return {
    action: 'seek',
    target: clampSeekTarget(pending.target, duration),
    nextPending: {
      ...pending,
      startedAt,
      attempts: pending.attempts + 1,
      lastSeekAt: now,
    },
  };
}

export function evaluateSeekProgress(pending, loadedMixcloudKey, position, duration, now) {
  if (typeof duration === 'number' && duration <= 0) {
    return { action: 'ignore', seekTarget: null, nextPending: pending, ignorePosition: true };
  }

  if (!pending || pending.mixcloudKey !== loadedMixcloudKey) {
    return { action: 'none', seekTarget: null, nextPending: pending, ignorePosition: false };
  }

  if (typeof duration !== 'number') {
    if (position <= 0) {
      return { action: 'wait', seekTarget: null, nextPending: pending, ignorePosition: false };
    }
    if (Math.abs(position - pending.target) > SEEK_TOLERANCE_SECONDS) {
      return { action: 'seek', seekTarget: pending.target, nextPending: null, ignorePosition: false };
    }
    return { action: 'confirmed', seekTarget: null, nextPending: null, ignorePosition: false };
  }

  const effectiveTarget = clampSeekTarget(pending.target, duration);
  if (Math.abs(position - effectiveTarget) <= SEEK_TOLERANCE_SECONDS) {
    if (pending.nearTargetPos !== null && position > pending.nearTargetPos) {
      return { action: 'confirmed', seekTarget: null, nextPending: null, ignorePosition: false };
    }
    const nextTicks = pending.nearTargetTicks + 1;
    if (nextTicks >= 3) {
      return { action: 'confirmed', seekTarget: null, nextPending: null, ignorePosition: false };
    }
    const nextNearPos = pending.nearTargetPos === null ? position : Math.min(pending.nearTargetPos, position);
    return {
      action: 'wait',
      seekTarget: null,
      nextPending: {
        ...pending,
        startedAt: pending.startedAt ?? now,
        nearTargetPos: nextNearPos,
        nearTargetTicks: nextTicks,
      },
      ignorePosition: false,
    };
  }

  const resetPending = { ...pending, nearTargetPos: null, nearTargetTicks: 0 };
  const attempt = evaluateSeekAttempt(resetPending, loadedMixcloudKey, now, duration);
  if (attempt.action === 'clear') {
    return { action: 'clear', seekTarget: null, nextPending: null, ignorePosition: false };
  }
  return {
    action: attempt.action,
    seekTarget: attempt.target,
    nextPending: attempt.nextPending,
    ignorePosition: true,
  };
}

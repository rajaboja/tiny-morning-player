const state = {
  episodes: [],
  selectedEpisode: null,
  tracks: [],
  filter: '',
  syncOffsetSeconds: 0,
  loadedMixcloudKey: null,
  widget: null,
  widgetReady: false,
  pendingSeekSeconds: null,
  lastPositionSeconds: 0,
  activeTrackIndex: -1,
};

const el = {
  episodeList: document.getElementById('episode-list'),
  episodeCount: document.getElementById('episode-count'),
  episodeHeader: document.getElementById('episode-header'),
  epArt: document.getElementById('ep-art'),
  epTitle: document.getElementById('ep-title'),
  epDesc: document.getElementById('ep-desc'),
  epMixcloudLink: document.getElementById('ep-mixcloud-link'),
  epSpinitronLink: document.getElementById('ep-spinitron-link'),
  tracklistContainer: document.getElementById('tracklist-container'),
  trackSearch: document.getElementById('track-search'),
  syncValue: document.getElementById('sync-value'),
  playerStatus: document.getElementById('player-status'),
  playerMount: document.getElementById('player-mount'),
  sidebar: document.getElementById('sidebar'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  episodesToggle: document.getElementById('episodes-toggle'),
  drawerClose: document.getElementById('drawer-close'),
};

function setDrawerOpen(open) {
  el.sidebar.classList.toggle('open', open);
  el.drawerBackdrop.classList.toggle('open', open);
  el.episodesToggle.setAttribute('aria-expanded', String(open));
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatEpisodeLength(seconds) {
  if (!seconds) return '';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function renderEpisodes() {
  el.episodeCount.textContent = String(state.episodes.length);
  if (!state.episodes.length) {
    el.episodeList.innerHTML = '<div class="status">No episodes found.</div>';
    return;
  }

  el.episodeList.innerHTML = state.episodes.map((ep, idx) => {
    const isActive = state.selectedEpisode?.mixcloudKey === ep.mixcloudKey;
    const dur = formatEpisodeLength(ep.audioLength);
    const tag = dur ? `<span class="episode-tag">${escapeHtml(dur)}</span>` : '';
    return `
      <button type="button" class="episode-item ${isActive ? 'active' : ''}" data-idx="${idx}">
        ${ep.picture ? `<img src="${escapeHtml(ep.picture)}" alt="" loading="lazy">` : ''}
        <div class="episode-info">
          <div class="episode-date">${escapeHtml(ep.date || 'Unknown date')}</div>
          <div class="episode-name">${escapeHtml(ep.name)}</div>
        </div>
        ${tag}
      </button>
    `;
  }).join('');
}

function renderTracks() {
  const q = state.filter.trim().toLowerCase();
  const filtered = state.tracks
    .map((t, idx) => ({ ...t, _idx: idx }))
    .filter((t) => {
      if (!q) return true;
      return (
        t.song.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
      );
    });

  if (!filtered.length) {
    el.tracklistContainer.innerHTML = '<div class="status">No matching tracks.</div>';
    return;
  }

  const rows = filtered.map((t) => {
    const effectiveOffset = Math.max(0, t.offsetSeconds + state.syncOffsetSeconds);
    const isPlaying = state.activeTrackIndex === t._idx;
    return `
      <tr class="track-row ${isPlaying ? 'playing' : ''}" data-idx="${t._idx}">
        <td class="track-play">
          <button type="button" class="play-btn" aria-label="Play ${escapeHtml(t.song)}">&#9654;</button>
        </td>
        <td class="track-offset">
          <div>${formatDuration(effectiveOffset)}</div>
          ${t.time ? `<div class="track-clock">${escapeHtml(t.time)}</div>` : ''}
        </td>
        <td class="track-info">
          <div class="track-song">${escapeHtml(t.song)}</div>
          <div class="track-artist">${escapeHtml(t.artist)}</div>
        </td>
        <td class="track-album">${escapeHtml(t.album)}</td>
      </tr>
    `;
  }).join('');

  el.tracklistContainer.innerHTML = `
    <table class="track-table">
      <thead>
        <tr>
          <th></th>
          <th>Time</th>
          <th>Track / Artist</th>
          <th>Album</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateActiveTrackFromProgress(positionSeconds) {
  if (!state.tracks.length || state.loadedMixcloudKey !== state.selectedEpisode?.mixcloudKey) {
    return;
  }
  let idx = -1;
  for (let i = 0; i < state.tracks.length; i++) {
    const start = Math.max(0, state.tracks[i].offsetSeconds + state.syncOffsetSeconds);
    if (positionSeconds >= start) idx = i;
    else break;
  }
  if (idx !== state.activeTrackIndex) {
    state.activeTrackIndex = idx;
    document.querySelectorAll('.track-row').forEach((row) => {
      row.classList.toggle('playing', Number(row.dataset.idx) === idx);
    });
  }
}

async function mountWidget(mixcloudKey, autoplay = false) {
  if (!state.widget) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media';
    iframe.src = `https://player-widget.mixcloud.com/widget/iframe/?hide_cover=1&mini=1&autoplay=${autoplay ? 1 : 0}&feed=${encodeURIComponent(mixcloudKey)}`;
    el.playerMount.innerHTML = '';
    el.playerMount.appendChild(iframe);

    state.loadedMixcloudKey = mixcloudKey;
    state.widgetReady = false;

    const widget = window.Mixcloud.PlayerWidget(iframe);
    state.widget = widget;

    await widget.ready;
    state.widgetReady = true;

    widget.events.progress.on((position) => {
      state.lastPositionSeconds = position;
      if (state.pendingSeekSeconds !== null && position > 0) {
        const toSeek = state.pendingSeekSeconds;
        state.pendingSeekSeconds = null;
        if (Math.abs(position - toSeek) > 3) {
          widget.seek(toSeek);
        }
      }
      updateActiveTrackFromProgress(position);
    });
    return;
  }

  if (state.loadedMixcloudKey !== mixcloudKey) {
    state.loadedMixcloudKey = mixcloudKey;
    state.lastPositionSeconds = 0;
    await state.widget.ready;
    await state.widget.load(mixcloudKey, autoplay);
  }
}

async function ensureWidgetForEpisode(mixcloudKey, seekSeconds) {
  const target = Math.max(0, Math.floor(seekSeconds));
  state.pendingSeekSeconds = target;

  await mountWidget(mixcloudKey, true);
  await state.widget.play();
  if (target > 0) {
    await state.widget.seek(target);
  }
}

async function playTrack(trackIdx) {
  const track = state.tracks[trackIdx];
  const ep = state.selectedEpisode;
  if (!track || !ep) return;

  const targetSeconds = Math.max(0, track.offsetSeconds + state.syncOffsetSeconds);
  state.activeTrackIndex = trackIdx;
  renderTracks();

  el.playerStatus.textContent = `Playing: ${track.artist} — ${track.song} (jumping to ${formatDuration(targetSeconds)})`;
  try {
    await ensureWidgetForEpisode(ep.mixcloudKey, targetSeconds);
  } catch (err) {
    console.error(err);
    el.playerStatus.textContent = `Loaded episode. If Mixcloud did not auto-seek, scrub to ${formatDuration(targetSeconds)}.`;
  }
}

async function selectEpisode(ep) {
  state.selectedEpisode = ep;
  state.tracks = [];
  state.activeTrackIndex = -1;
  renderEpisodes();

  if (!state.widget) {
    mountWidget(ep.mixcloudKey, false).catch(() => {});
  }

  el.episodeHeader.classList.remove('hidden');
  el.epArt.src = ep.picture || '';
  el.epTitle.textContent = ep.name;
  el.epDesc.textContent = '';
  el.epMixcloudLink.href = ep.mixcloudUrl;

  if (ep.spinitronUrl) {
    el.epSpinitronLink.style.display = '';
    el.epSpinitronLink.href = ep.spinitronUrl;
  } else {
    el.epSpinitronLink.style.display = 'none';
  }

  el.tracklistContainer.innerHTML = '<div class="status">Loading tracklist...</div>';

  try {
    const query = ep.spinitronId ? `?spinitronId=${encodeURIComponent(ep.spinitronId)}` : '';
    const res = await fetch(`/api/episodes/${encodeURIComponent(ep.slug)}/tracks${query}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (state.selectedEpisode?.mixcloudKey !== ep.mixcloudKey) return;

    el.epDesc.textContent = data.description || '';
    state.tracks = data.tracks || [];
    if (!state.tracks.length) {
      el.tracklistContainer.innerHTML = `
        <div class="status">
          No tracklist available for ${escapeHtml(ep.date || 'this episode')}.
          <br><br>
          <button type="button" id="play-full-ep" class="play-btn" style="width:auto;padding:6px 14px;border-radius:6px;">
            Play full episode on Mixcloud
          </button>
        </div>
      `;
      document.getElementById('play-full-ep')?.addEventListener('click', () => {
        ensureWidgetForEpisode(ep.mixcloudKey, 0);
      });
      return;
    }
    renderTracks();
    if (state.lastPositionSeconds > 0) {
      updateActiveTrackFromProgress(state.lastPositionSeconds);
    }
  } catch (err) {
    if (state.selectedEpisode?.mixcloudKey !== ep.mixcloudKey) return;
    el.tracklistContainer.innerHTML = `<div class="status">Failed to load tracklist: ${escapeHtml(err.message)}</div>`;
  }
}

el.episodesToggle.addEventListener('click', () => {
  setDrawerOpen(!el.sidebar.classList.contains('open'));
});

el.drawerClose.addEventListener('click', () => setDrawerOpen(false));
el.drawerBackdrop.addEventListener('click', () => setDrawerOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setDrawerOpen(false);
});

el.episodeList.addEventListener('click', (e) => {
  const btn = e.target.closest('.episode-item');
  if (!btn) return;
  const ep = state.episodes[Number(btn.dataset.idx)];
  if (ep) {
    setDrawerOpen(false);
    selectEpisode(ep);
  }
});

el.tracklistContainer.addEventListener('click', (e) => {
  const row = e.target.closest('.track-row');
  if (!row) return;
  playTrack(Number(row.dataset.idx));
});

el.trackSearch.addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderTracks();
});

document.querySelectorAll('.sync-control button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.syncOffsetSeconds += Number(btn.dataset.nudge);
    const sign = state.syncOffsetSeconds > 0 ? '+' : '';
    el.syncValue.textContent = `${sign}${state.syncOffsetSeconds}s`;
    renderTracks();
  });
});

async function init() {
  try {
    const res = await fetch('/api/episodes');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.episodes = data.episodes || [];
    renderEpisodes();
    if (state.episodes[0]) {
      selectEpisode(state.episodes[0]);
    }
  } catch (err) {
    el.episodeList.innerHTML = `<div class="status">Failed to load episodes: ${escapeHtml(err.message)}</div>`;
  }
}

init();

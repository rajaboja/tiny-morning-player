import {
  formatDuration,
  escapeHtml,
  formatEpisodeLength,
  formatTrackLabel,
  parseDeepLink,
  buildTrackUrl,
  buildListUrl,
  makeTrackKey,
  resolveTrackIndexByTime,
  filterTracks,
  createPendingSeek,
  evaluateSeekAttempt,
  evaluateSeekProgress,
} from './lib.js';

const DEFAULT_TITLE = document.title;
const SHARE_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const CHECK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const HEART_OUTLINE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const HEART_FILLED_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const LIST_ADD_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

const state = {
  view: 'episode',
  sidebarTab: 'episodes',
  episodes: [],
  selectedEpisode: null,
  tracks: [],
  favorites: [],
  favoriteKeys: new Set(),
  lists: [],
  selectedList: null,
  listMembershipCache: new Map(),
  modalTrack: null,
  renamingList: false,
  filter: '',
  syncOffsetSeconds: 0,
  loadedMixcloudKey: null,
  widget: null,
  widgetInitPromise: null,
  switchingCount: 0,
  playRequestId: 0,
  pendingSeek: null,
  lastPositionSeconds: 0,
  activeTrackIndex: -1,
  activeSavedKey: null,
  sharedTrackIndex: -1,
};

const el = {
  episodeList: document.getElementById('episode-list'),
  episodeCount: document.getElementById('episode-count'),
  favoritesCount: document.getElementById('favorites-count'),
  listsCount: document.getElementById('lists-count'),
  listsPanel: document.getElementById('lists-panel'),
  listsList: document.getElementById('lists-list'),
  createListForm: document.getElementById('create-list-form'),
  newListName: document.getElementById('new-list-name'),
  sidebarTabs: document.querySelectorAll('.sidebar-tab'),
  episodeHeader: document.getElementById('episode-header'),
  epArt: document.getElementById('ep-art'),
  epTitle: document.getElementById('ep-title'),
  epDesc: document.getElementById('ep-desc'),
  epMixcloudLink: document.getElementById('ep-mixcloud-link'),
  epSpinitronLink: document.getElementById('ep-spinitron-link'),
  collectionHeader: document.getElementById('collection-header'),
  collectionTitle: document.getElementById('collection-title'),
  collectionSubtitle: document.getElementById('collection-subtitle'),
  collectionActions: document.getElementById('collection-actions'),
  tracklistContainer: document.getElementById('tracklist-container'),
  trackSearch: document.getElementById('track-search'),
  syncValue: document.getElementById('sync-value'),
  playerStatus: document.getElementById('player-status'),
  playerMount: document.getElementById('player-mount'),
  sidebar: document.getElementById('sidebar'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  episodesToggle: document.getElementById('episodes-toggle'),
  drawerClose: document.getElementById('drawer-close'),
  listModal: document.getElementById('list-modal'),
  listModalClose: document.getElementById('list-modal-close'),
  listModalTrack: document.getElementById('list-modal-track'),
  listModalOptions: document.getElementById('list-modal-options'),
  modalCreateListForm: document.getElementById('modal-create-list-form'),
  modalNewListName: document.getElementById('modal-new-list-name'),
};

function setDrawerOpen(open) {
  el.sidebar.classList.toggle('open', open);
  el.drawerBackdrop.classList.toggle('open', open);
  el.episodesToggle.setAttribute('aria-expanded', String(open));
}

function setSidebarTab(tab) {
  state.sidebarTab = tab;
  el.sidebarTabs.forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  const showLists = tab === 'lists';
  el.listsPanel.classList.toggle('hidden', !showLists);
  el.episodeList.classList.toggle('hidden', showLists);
}

function syncUrl(ep, trackIdx = null) {
  if (!ep) return;
  const params = new URLSearchParams();
  params.set('ep', ep.slug);
  const track = trackIdx !== null && trackIdx >= 0 ? state.tracks[trackIdx] : null;
  if (track) {
    params.set('track', String(trackIdx + 1));
    document.title = `${formatTrackLabel(track)} · My Tiny Morning Show`;
  } else {
    document.title = ep.name ? `${ep.name} · My Tiny Morning Show` : DEFAULT_TITLE;
  }
  const nextUrl = `/?${params.toString()}`;
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function syncListUrl(list) {
  if (!list) return;
  const params = new URLSearchParams({ list: list.id });
  document.title = `${list.name} · My Tiny Morning Show`;
  const nextUrl = `/?${params.toString()}`;
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function buildSavedTrackPayload(ep, track, trackIdx) {
  return {
    episodeSlug: ep.slug,
    trackIndex: trackIdx,
    artist: track.artist || '',
    song: track.song || '',
    album: track.album || '',
    time: track.time || '',
    offsetSeconds: Math.max(0, Math.floor(track.offsetSeconds || 0)),
    artwork: track.artwork || ep.picture || null,
    episodeName: ep.name || '',
    episodeDate: ep.date || null,
    mixcloudKey: ep.mixcloudKey || '',
  };
}

function updateCounts() {
  el.episodeCount.textContent = String(state.episodes.length);
  el.favoritesCount.textContent = String(state.favorites.length);
  el.listsCount.textContent = String(state.lists.length);
}

function renderEpisodes() {
  updateCounts();
  if (!state.episodes.length) {
    el.episodeList.innerHTML = '<div class="status">No episodes found.</div>';
    return;
  }

  el.episodeList.innerHTML = state.episodes.map((ep, idx) => {
    const isActive = state.view === 'episode' && state.selectedEpisode?.mixcloudKey === ep.mixcloudKey;
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

function renderListsSidebar() {
  updateCounts();
  if (!state.lists.length) {
    el.listsList.innerHTML = '<div class="status">No lists yet. Create one above!</div>';
    return;
  }

  el.listsList.innerHTML = state.lists.map((list) => {
    const isActive = state.view === 'list' && state.selectedList?.id === list.id;
    return `
      <button type="button" class="list-item ${isActive ? 'active' : ''}" data-list-id="${escapeHtml(list.id)}">
        <span class="list-item-name">${escapeHtml(list.name)}</span>
        <span class="badge">${list.itemCount}</span>
      </button>
    `;
  }).join('');
}

function renderTracks() {
  const ep = state.selectedEpisode;
  const filtered = filterTracks(state.tracks, state.filter);

  if (!filtered.length) {
    el.tracklistContainer.innerHTML = '<div class="status">No matching tracks.</div>';
    return;
  }

  const rows = filtered.map((t) => {
    const effectiveOffset = Math.max(0, t.offsetSeconds + state.syncOffsetSeconds);
    const isPlaying = state.activeTrackIndex === t._idx;
    const isShared = state.sharedTrackIndex === t._idx && !isPlaying;
    const key = ep ? makeTrackKey(ep.slug, t._idx) : '';
    const isFav = state.favoriteKeys.has(key);
    const label = formatTrackLabel(t);
    return `
      <tr class="track-row ${isPlaying ? 'playing' : ''} ${isShared ? 'shared' : ''}" data-idx="${t._idx}">
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
        <td class="track-share">
          <div class="track-actions-wrap">
            <button type="button" class="fav-btn ${isFav ? 'favorited' : ''}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}: ${escapeHtml(label)}" aria-pressed="${isFav}" title="${isFav ? 'Remove favorite' : 'Favorite track'}">${isFav ? HEART_FILLED_SVG : HEART_OUTLINE_SVG}</button>
            <button type="button" class="list-add-btn" aria-label="Add ${escapeHtml(label)} to list" title="Add to list">${LIST_ADD_SVG}</button>
            <button type="button" class="share-btn" aria-label="Share ${escapeHtml(label)}" title="Share track link">${SHARE_ICON_SVG}</button>
          </div>
        </td>
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
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSavedTracksTable(items, mode) {
  const filtered = filterTracks(items, state.filter);
  if (!items.length) {
    const emptyMsg = mode === 'favorites'
      ? 'No favorite tracks yet. Click the heart icon on any track to save it.'
      : 'This list is empty. Use the + button on any track to add songs here.';
    el.tracklistContainer.innerHTML = `<div class="status">${emptyMsg}</div>`;
    return;
  }
  if (!filtered.length) {
    el.tracklistContainer.innerHTML = '<div class="status">No matching tracks.</div>';
    return;
  }

  const rows = filtered.map((t) => {
    const key = makeTrackKey(t.episodeSlug, t.trackIndex);
    const isFav = state.favoriteKeys.has(key);
    const isPlaying = state.activeSavedKey === key;
    const label = formatTrackLabel(t);
    const epMeta = [t.episodeDate, t.episodeName].filter(Boolean).join(' · ');
    return `
      <tr class="track-row saved-track-row ${isPlaying ? 'playing' : ''}" data-saved-idx="${t._idx}">
        <td class="track-play">
          <button type="button" class="play-btn" aria-label="Play ${escapeHtml(t.song)}">&#9654;</button>
        </td>
        <td class="track-offset">
          <div>${formatDuration(t.offsetSeconds)}</div>
          ${t.time ? `<div class="track-clock">${escapeHtml(t.time)}</div>` : ''}
        </td>
        <td class="track-info">
          <div class="track-song">${escapeHtml(t.song)}</div>
          <div class="track-artist">${escapeHtml(t.artist)}</div>
          ${epMeta ? `<div class="track-ep-meta">${escapeHtml(epMeta)}</div>` : ''}
        </td>
        <td class="track-album">${escapeHtml(t.album)}</td>
        <td class="track-share">
          <div class="track-actions-wrap">
            <button type="button" class="fav-btn ${isFav ? 'favorited' : ''}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}: ${escapeHtml(label)}" aria-pressed="${isFav}" title="${isFav ? 'Remove favorite' : 'Favorite track'}">${isFav ? HEART_FILLED_SVG : HEART_OUTLINE_SVG}</button>
            ${mode === 'list'
              ? `<button type="button" class="remove-item-btn" aria-label="Remove ${escapeHtml(label)} from list" title="Remove from list">${TRASH_SVG}</button>`
              : `<button type="button" class="list-add-btn" aria-label="Add ${escapeHtml(label)} to list" title="Add to list">${LIST_ADD_SVG}</button>`}
            <button type="button" class="share-btn" aria-label="Share ${escapeHtml(label)}" title="Share track link">${SHARE_ICON_SVG}</button>
          </div>
        </td>
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
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderCollectionHeader() {
  if (state.view === 'favorites') {
    el.episodeHeader.classList.add('hidden');
    el.collectionHeader.classList.remove('hidden');
    el.collectionTitle.textContent = 'Favorites';
    const n = state.favorites.length;
    el.collectionSubtitle.textContent = `${n} saved ${n === 1 ? 'track' : 'tracks'}`;
    el.collectionActions.innerHTML = '';
    return;
  }

  if (state.view === 'list' && state.selectedList) {
    const list = state.selectedList;
    el.episodeHeader.classList.add('hidden');
    el.collectionHeader.classList.remove('hidden');
    const n = list.items.length;
    el.collectionSubtitle.textContent = `${n} ${n === 1 ? 'track' : 'tracks'}${list.description ? ` · ${list.description}` : ''}`;

    if (state.renamingList) {
      el.collectionTitle.innerHTML = '';
      el.collectionActions.innerHTML = `
        <form id="rename-list-form" class="create-list-form" style="padding:0;border:0;">
          <input id="rename-list-input" type="text" value="${escapeHtml(list.name)}" maxlength="120" required>
          <button type="submit" class="primary-btn">Save</button>
          <button type="button" id="cancel-rename-btn" class="secondary-btn">Cancel</button>
        </form>
      `;
      document.getElementById('rename-list-input')?.focus();
    } else {
      el.collectionTitle.textContent = list.name;
      el.collectionActions.innerHTML = `
        <button type="button" id="share-list-btn" class="secondary-btn">${SHARE_ICON_SVG} Share list</button>
        <button type="button" id="rename-list-btn" class="secondary-btn">Rename</button>
        <button type="button" id="delete-list-btn" class="danger-btn">Delete</button>
      `;
    }
    return;
  }

  el.collectionHeader.classList.add('hidden');
  if (state.selectedEpisode) {
    el.episodeHeader.classList.remove('hidden');
  }
}

function renderCurrentView() {
  renderEpisodes();
  renderListsSidebar();
  renderCollectionHeader();
  if (state.view === 'favorites') {
    renderSavedTracksTable(state.favorites, 'favorites');
  } else if (state.view === 'list' && state.selectedList) {
    renderSavedTracksTable(state.selectedList.items, 'list');
  } else {
    renderTracks();
  }
}

function updateActiveTrackFromProgress(positionSeconds) {
  if (state.view !== 'episode' || !state.tracks.length || state.loadedMixcloudKey !== state.selectedEpisode?.mixcloudKey) {
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
    state.sharedTrackIndex = -1;
    document.querySelectorAll('.track-row').forEach((row) => {
      const rowIdx = Number(row.dataset.idx);
      row.classList.toggle('playing', rowIdx === idx);
      row.classList.remove('shared');
    });
  }
}

function triggerPendingSeek(duration) {
  if (!state.widget || state.switchingCount > 0 || !state.pendingSeek) return;
  const result = evaluateSeekAttempt(state.pendingSeek, state.loadedMixcloudKey, Date.now(), duration);
  state.pendingSeek = result.nextPending;
  if (result.action === 'seek') {
    Promise.resolve(state.widget.seek(result.target)).catch(() => {});
  }
}

function attachWidgetListeners(widget) {
  widget.events?.play?.on(() => {
    if (state.switchingCount > 0 || !state.pendingSeek) return;
    if (state.pendingSeek.nearTargetPos === null) {
      triggerPendingSeek();
    }
  });

  widget.events?.progress?.on((position, duration) => {
    if (state.switchingCount > 0) return;

    const result = evaluateSeekProgress(
      state.pendingSeek,
      state.loadedMixcloudKey,
      position,
      duration,
      Date.now(),
    );
    state.pendingSeek = result.nextPending;

    if (result.action === 'seek') {
      Promise.resolve(widget.seek(result.seekTarget)).catch(() => {});
    }
    if (result.ignorePosition) return;

    state.lastPositionSeconds = position;
    updateActiveTrackFromProgress(position);
  });
}

async function mountWidget(mixcloudKey, autoplay = false) {
  if (!state.widget) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media';
    iframe.src = `https://player-widget.mixcloud.com/widget/iframe/?hide_cover=1&mini=1&autoplay=${autoplay ? 1 : 0}&feed=${encodeURIComponent(mixcloudKey)}`;
    el.playerMount.innerHTML = '';
    el.playerMount.appendChild(iframe);

    state.loadedMixcloudKey = mixcloudKey;
    const widget = window.Mixcloud.PlayerWidget(iframe);
    state.widget = widget;
    state.widgetInitPromise = (async () => {
      try {
        await widget.ready;
        attachWidgetListeners(widget);
      } catch (err) {
        if (state.widget === widget) {
          state.widget = null;
          state.widgetInitPromise = null;
          state.loadedMixcloudKey = null;
        }
        throw err;
      }
    })();

    await state.widgetInitPromise;
    return;
  }

  await state.widgetInitPromise;

  if (state.loadedMixcloudKey !== mixcloudKey) {
    state.loadedMixcloudKey = mixcloudKey;
    state.lastPositionSeconds = 0;
    state.switchingCount += 1;
    try {
      await state.widget.load(mixcloudKey, autoplay);
    } finally {
      state.switchingCount = Math.max(0, state.switchingCount - 1);
    }
  }
}

async function ensureWidgetForEpisode(mixcloudKey, seekSeconds) {
  const reqId = ++state.playRequestId;
  const target = Math.max(0, Math.floor(seekSeconds));
  const episodeChanged = !state.widget || state.loadedMixcloudKey !== mixcloudKey;
  state.pendingSeek = null;

  await mountWidget(mixcloudKey, true);
  if (reqId !== state.playRequestId) return;

  state.pendingSeek = target > 0 ? createPendingSeek(mixcloudKey, target) : null;

  await state.widget.play();
  if (reqId !== state.playRequestId) return;

  if (target > 0) {
    triggerPendingSeek();
  } else if (!episodeChanged && state.lastPositionSeconds > 3) {
    Promise.resolve(state.widget.seek(0)).catch(() => {});
  }
}

async function playTrack(trackIdx) {
  const track = state.tracks[trackIdx];
  const ep = state.selectedEpisode;
  if (!track || !ep) return;

  const targetSeconds = Math.max(0, track.offsetSeconds + state.syncOffsetSeconds);
  state.activeTrackIndex = trackIdx;
  state.activeSavedKey = makeTrackKey(ep.slug, trackIdx);
  state.sharedTrackIndex = -1;
  syncUrl(ep, trackIdx);
  renderTracks();

  el.playerStatus.textContent = `Playing: ${formatTrackLabel(track)} (jumping to ${formatDuration(targetSeconds)})`;
  try {
    await ensureWidgetForEpisode(ep.mixcloudKey, targetSeconds);
  } catch (err) {
    console.error(err);
    el.playerStatus.textContent = `Loaded episode. If Mixcloud did not auto-seek, scrub to ${formatDuration(targetSeconds)}.`;
  }
}

async function playSavedTrack(item) {
  if (!item) return;
  const ep = state.episodes.find((e) => e.slug === item.episodeSlug);
  const mixcloudKey = item.mixcloudKey || ep?.mixcloudKey;
  if (!mixcloudKey) {
    el.playerStatus.textContent = 'Episode audio link is unavailable for this track.';
    return;
  }

  const targetSeconds = Math.max(0, Math.floor(item.offsetSeconds || 0));
  state.activeSavedKey = makeTrackKey(item.episodeSlug, item.trackIndex);
  renderCurrentView();

  el.playerStatus.textContent = `Playing: ${formatTrackLabel(item)} (jumping to ${formatDuration(targetSeconds)})`;
  try {
    await ensureWidgetForEpisode(mixcloudKey, targetSeconds);
  } catch (err) {
    console.error(err);
    el.playerStatus.textContent = `Loaded episode. If Mixcloud did not auto-seek, scrub to ${formatDuration(targetSeconds)}.`;
  }
}

function showSharedTrackPrompt(trackIdx) {
  const track = state.tracks[trackIdx];
  const ep = state.selectedEpisode;
  if (!track || !ep) return;

  const targetSeconds = Math.max(0, track.offsetSeconds + state.syncOffsetSeconds);
  state.sharedTrackIndex = trackIdx;
  state.pendingSeek = createPendingSeek(ep.mixcloudKey, targetSeconds);
  renderTracks();

  const row = el.tracklistContainer.querySelector(`.track-row[data-idx="${trackIdx}"]`);
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  el.playerStatus.innerHTML = `
    <span class="player-status-text">Shared track: <strong>${escapeHtml(formatTrackLabel(track))}</strong> (${formatDuration(targetSeconds)})</span>
    <button type="button" class="status-play-btn" data-play-idx="${trackIdx}">&#9654; Play track</button>
  `;
}

async function selectEpisode(ep, options = {}) {
  const { deepLink = null, updateUrl = true } = options;
  state.view = 'episode';
  state.selectedList = null;
  state.renamingList = false;
  state.selectedEpisode = ep;
  state.tracks = [];
  state.activeTrackIndex = -1;
  state.sharedTrackIndex = -1;
  if (state.pendingSeek && state.pendingSeek.startedAt === null) {
    state.pendingSeek = null;
  }
  setSidebarTab('episodes');
  renderEpisodes();
  renderListsSidebar();

  if (updateUrl && !deepLink) {
    syncUrl(ep);
  }

  if (!state.widget) {
    mountWidget(ep.mixcloudKey, false).catch(() => {});
  }

  el.collectionHeader.classList.add('hidden');
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
    if (state.view !== 'episode' || state.selectedEpisode?.mixcloudKey !== ep.mixcloudKey) return;

    el.epDesc.textContent = data.description || '';
    state.tracks = data.tracks || [];
    if (!state.tracks.length) {
      const seekAt = deepLink?.seconds || 0;
      if (deepLink) {
        syncUrl(ep);
        if (seekAt > 0) state.pendingSeek = createPendingSeek(ep.mixcloudKey, seekAt);
      }
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
        ensureWidgetForEpisode(ep.mixcloudKey, seekAt);
      });
      return;
    }

    if (deepLink) {
      let targetIdx = null;
      if (deepLink.trackIndex !== null && deepLink.trackIndex < state.tracks.length) {
        targetIdx = deepLink.trackIndex;
      } else if (deepLink.seconds !== null) {
        targetIdx = resolveTrackIndexByTime(state.tracks, deepLink.seconds, state.syncOffsetSeconds);
      }
      if (targetIdx !== null && state.tracks[targetIdx]) {
        syncUrl(ep, targetIdx);
        showSharedTrackPrompt(targetIdx);
        return;
      }
      syncUrl(ep);
    }

    renderTracks();
    if (state.lastPositionSeconds > 0) {
      updateActiveTrackFromProgress(state.lastPositionSeconds);
    }
  } catch (err) {
    if (state.view !== 'episode' || state.selectedEpisode?.mixcloudKey !== ep.mixcloudKey) return;
    el.tracklistContainer.innerHTML = `<div class="status">Failed to load tracklist: ${escapeHtml(err.message)}</div>`;
  }
}

async function openFavoritesView() {
  state.view = 'favorites';
  state.selectedList = null;
  state.renamingList = false;
  document.title = 'Favorites · My Tiny Morning Show';
  setSidebarTab('favorites');
  setDrawerOpen(false);
  renderCurrentView();
}

async function openList(listId, options = {}) {
  const { updateUrl = true } = options;
  try {
    const res = await fetch(`/api/lists/${encodeURIComponent(listId)}`);
    if (!res.ok) return false;
    const { list } = await res.json();
    state.view = 'list';
    state.selectedList = list;
    state.renamingList = false;
    state.listMembershipCache.set(list.id, new Set(list.items.map((it) => makeTrackKey(it.episodeSlug, it.trackIndex))));
    setSidebarTab('lists');
    if (updateUrl) syncListUrl(list);
    setDrawerOpen(false);
    renderCurrentView();
    return true;
  } catch {
    return false;
  }
}

async function loadFavorites() {
  const res = await fetch('/api/favorites');
  if (!res.ok) return;
  const data = await res.json();
  state.favorites = data.favorites || [];
  state.favoriteKeys = new Set(state.favorites.map((f) => makeTrackKey(f.episodeSlug, f.trackIndex)));
  updateCounts();
}

async function loadLists() {
  const res = await fetch('/api/lists');
  if (!res.ok) return;
  const data = await res.json();
  state.lists = data.lists || [];
  updateCounts();
  renderListsSidebar();
}

async function toggleFavorite(item) {
  if (!item) return;
  const key = makeTrackKey(item.episodeSlug, item.trackIndex);
  const wasFav = state.favoriteKeys.has(key);

  if (wasFav) {
    const res = await fetch(
      `/api/favorites/${encodeURIComponent(item.episodeSlug)}/${encodeURIComponent(item.trackIndex)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) return;
    state.favoriteKeys.delete(key);
    state.favorites = state.favorites.filter((f) => makeTrackKey(f.episodeSlug, f.trackIndex) !== key);
  } else {
    const res = await fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (!res.ok) return;
    const { favorite } = await res.json();
    state.favoriteKeys.add(key);
    state.favorites = [
      favorite,
      ...state.favorites.filter((f) => makeTrackKey(f.episodeSlug, f.trackIndex) !== key),
    ];
  }
  renderCurrentView();
}

async function createList(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const res = await fetch('/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmed }),
  });
  if (!res.ok) return null;
  const { list } = await res.json();
  state.listMembershipCache.set(list.id, new Set());
  await loadLists();
  return list;
}

async function addTrackToList(listId, item) {
  const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) return null;
  const { list } = await res.json();
  state.listMembershipCache.set(list.id, new Set(list.items.map((it) => makeTrackKey(it.episodeSlug, it.trackIndex))));
  if (state.selectedList?.id === list.id) {
    state.selectedList = list;
  }
  await loadLists();
  renderCurrentView();
  return list;
}

async function removeTrackFromList(listId, episodeSlug, trackIndex) {
  const res = await fetch(
    `/api/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(episodeSlug)}/${encodeURIComponent(trackIndex)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) return false;
  const key = makeTrackKey(episodeSlug, trackIndex);
  state.listMembershipCache.get(listId)?.delete(key);
  if (state.selectedList?.id === listId) {
    state.selectedList = {
      ...state.selectedList,
      items: state.selectedList.items.filter((it) => makeTrackKey(it.episodeSlug, it.trackIndex) !== key),
    };
    state.selectedList.itemCount = state.selectedList.items.length;
  }
  await loadLists();
  renderCurrentView();
  return true;
}

async function hydrateModalMembership() {
  await Promise.all(
    state.lists.map(async (l) => {
      if (state.listMembershipCache.has(l.id)) return;
      const res = await fetch(`/api/lists/${encodeURIComponent(l.id)}`);
      if (!res.ok) return;
      const { list } = await res.json();
      state.listMembershipCache.set(
        list.id,
        new Set(list.items.map((it) => makeTrackKey(it.episodeSlug, it.trackIndex))),
      );
    }),
  );
}

function renderListModalOptions() {
  if (!state.modalTrack) return;
  const key = makeTrackKey(state.modalTrack.episodeSlug, state.modalTrack.trackIndex);
  if (!state.lists.length) {
    el.listModalOptions.innerHTML = '<div class="status" style="padding:12px;">No lists yet. Create one below.</div>';
    return;
  }
  el.listModalOptions.innerHTML = state.lists.map((l) => {
    const inList = state.listMembershipCache.get(l.id)?.has(key) || false;
    return `
      <button type="button" class="modal-list-row ${inList ? 'in-list' : ''}" data-modal-list-id="${escapeHtml(l.id)}">
        <span>${escapeHtml(l.name)}</span>
        <span class="badge">${inList ? 'Added' : '+ Add'}</span>
      </button>
    `;
  }).join('');
}

async function openListModal(item) {
  state.modalTrack = item;
  el.listModalTrack.textContent = formatTrackLabel(item);
  el.modalNewListName.value = '';
  el.listModal.classList.remove('hidden');
  el.listModalOptions.innerHTML = '<div class="status" style="padding:12px;">Loading lists...</div>';
  await hydrateModalMembership();
  renderListModalOptions();
}

function closeListModal() {
  state.modalTrack = null;
  el.listModal.classList.add('hidden');
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('Copy failed');
}

async function shareTrack(trackPayload, btn) {
  if (!trackPayload) return;
  const url = buildTrackUrl(window.location.origin, trackPayload.episodeSlug, trackPayload.trackIndex);
  const label = formatTrackLabel(trackPayload);
  const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches;

  if (isTouchDevice && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: label,
        text: trackPayload.episodeName ? `${label} — ${trackPayload.episodeName}` : label,
        url,
      });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await copyToClipboard(url);
    if (btn) {
      clearTimeout(btn._copiedTimer);
      btn.classList.add('copied');
      btn.innerHTML = CHECK_ICON_SVG;
      btn.title = 'Link copied!';
      btn._copiedTimer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = SHARE_ICON_SVG;
        btn.title = 'Share track link';
      }, 1800);
    }
  } catch (err) {
    console.error(err);
    el.playerStatus.textContent = `Could not copy link: ${url}`;
  }
}

async function shareList(list, btn) {
  if (!list) return;
  const url = buildListUrl(window.location.origin, list.id);
  const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches;

  if (isTouchDevice && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: list.name,
        text: `${list.name} · My Tiny Morning Show`,
        url,
      });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await copyToClipboard(url);
    if (btn) {
      clearTimeout(btn._copiedTimer);
      btn.classList.add('copied');
      btn.innerHTML = `${CHECK_ICON_SVG} Copied!`;
      btn._copiedTimer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `${SHARE_ICON_SVG} Share list`;
      }, 1800);
    }
  } catch (err) {
    console.error(err);
    el.playerStatus.textContent = `Could not copy link: ${url}`;
  }
}

el.episodesToggle.addEventListener('click', () => {
  setDrawerOpen(!el.sidebar.classList.contains('open'));
});

el.drawerClose.addEventListener('click', () => setDrawerOpen(false));
el.drawerBackdrop.addEventListener('click', () => setDrawerOpen(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.listModal.classList.contains('hidden')) {
      closeListModal();
      return;
    }
    setDrawerOpen(false);
  }
});

el.sidebarTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === 'favorites') {
      openFavoritesView();
      return;
    }
    setSidebarTab(tab);
    if (tab === 'episodes' && state.view !== 'episode' && state.selectedEpisode) {
      state.view = 'episode';
      state.selectedList = null;
      syncUrl(state.selectedEpisode);
      renderCurrentView();
    }
  });
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

el.listsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.list-item');
  if (!btn) return;
  openList(btn.dataset.listId);
});

el.createListForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const list = await createList(el.newListName.value);
  if (list) {
    el.newListName.value = '';
    await openList(list.id);
  }
});

el.collectionHeader.addEventListener('click', async (e) => {
  if (!state.selectedList) return;
  const shareBtn = e.target.closest('#share-list-btn');
  if (shareBtn) {
    shareList(state.selectedList, shareBtn);
    return;
  }
  if (e.target.closest('#rename-list-btn')) {
    state.renamingList = true;
    renderCollectionHeader();
    return;
  }
  if (e.target.closest('#cancel-rename-btn')) {
    state.renamingList = false;
    renderCollectionHeader();
    return;
  }
  if (e.target.closest('#delete-list-btn')) {
    const listId = state.selectedList.id;
    const res = await fetch(`/api/lists/${encodeURIComponent(listId)}`, { method: 'DELETE' });
    if (res.ok) {
      state.listMembershipCache.delete(listId);
      state.selectedList = null;
      await loadLists();
      if (state.episodes.length) {
        selectEpisode(state.episodes[0], { updateUrl: true });
      } else {
        state.view = 'favorites';
        renderCurrentView();
      }
    }
  }
});

el.collectionHeader.addEventListener('submit', async (e) => {
  const form = e.target.closest('#rename-list-form');
  if (!form || !state.selectedList) return;
  e.preventDefault();
  const input = document.getElementById('rename-list-input');
  const nextName = input?.value.trim();
  if (!nextName) return;
  const res = await fetch(`/api/lists/${encodeURIComponent(state.selectedList.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nextName }),
  });
  if (res.ok) {
    const { list } = await res.json();
    state.selectedList = list;
    state.renamingList = false;
    syncListUrl(list);
    await loadLists();
    renderCurrentView();
  }
});

el.listModalClose.addEventListener('click', closeListModal);
el.listModal.addEventListener('click', (e) => {
  if (e.target === el.listModal) closeListModal();
});

el.listModalOptions.addEventListener('click', async (e) => {
  const btn = e.target.closest('.modal-list-row');
  if (!btn || !state.modalTrack) return;
  const listId = btn.dataset.modalListId;
  const key = makeTrackKey(state.modalTrack.episodeSlug, state.modalTrack.trackIndex);
  const inList = state.listMembershipCache.get(listId)?.has(key) || false;
  if (inList) {
    await removeTrackFromList(listId, state.modalTrack.episodeSlug, state.modalTrack.trackIndex);
  } else {
    await addTrackToList(listId, state.modalTrack);
  }
  renderListModalOptions();
});

el.modalCreateListForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.modalTrack) return;
  const list = await createList(el.modalNewListName.value);
  if (!list) return;
  el.modalNewListName.value = '';
  await addTrackToList(list.id, state.modalTrack);
  renderListModalOptions();
});

el.playerStatus.addEventListener('click', (e) => {
  const btn = e.target.closest('.status-play-btn');
  if (!btn) return;
  playTrack(Number(btn.dataset.playIdx));
});

function getSavedTrackFromRow(row) {
  if (state.view === 'favorites') {
    return state.favorites[Number(row.dataset.savedIdx)] || null;
  }
  if (state.view === 'list' && state.selectedList) {
    return state.selectedList.items[Number(row.dataset.savedIdx)] || null;
  }
  const idx = Number(row.dataset.idx);
  const track = state.tracks[idx];
  const ep = state.selectedEpisode;
  if (!track || !ep) return null;
  return buildSavedTrackPayload(ep, track, idx);
}

el.tracklistContainer.addEventListener('click', (e) => {
  const row = e.target.closest('.track-row');
  if (!row) return;

  const favBtn = e.target.closest('.fav-btn');
  if (favBtn) {
    toggleFavorite(getSavedTrackFromRow(row));
    return;
  }

  const listAddBtn = e.target.closest('.list-add-btn');
  if (listAddBtn) {
    const item = getSavedTrackFromRow(row);
    if (item) openListModal(item);
    return;
  }

  const removeBtn = e.target.closest('.remove-item-btn');
  if (removeBtn && state.selectedList) {
    const item = getSavedTrackFromRow(row);
    if (item) removeTrackFromList(state.selectedList.id, item.episodeSlug, item.trackIndex);
    return;
  }

  const shareBtn = e.target.closest('.share-btn');
  if (shareBtn) {
    shareTrack(getSavedTrackFromRow(row), shareBtn);
    return;
  }

  if (state.view === 'episode') {
    playTrack(Number(row.dataset.idx));
  } else {
    playSavedTrack(getSavedTrackFromRow(row));
  }
});

el.trackSearch.addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderCurrentView();
});

document.querySelectorAll('.sync-control button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.syncOffsetSeconds += Number(btn.dataset.nudge);
    const sign = state.syncOffsetSeconds > 0 ? '+' : '';
    el.syncValue.textContent = `${sign}${state.syncOffsetSeconds}s`;
    if (state.sharedTrackIndex >= 0 && state.tracks[state.sharedTrackIndex]) {
      showSharedTrackPrompt(state.sharedTrackIndex);
      return;
    }
    renderTracks();
  });
});

async function init() {
  const deepLink = parseDeepLink(window.location.search);
  try {
    const [epRes] = await Promise.all([
      fetch('/api/episodes'),
      loadFavorites().catch(() => {}),
      loadLists().catch(() => {}),
    ]);
    if (!epRes.ok) throw new Error(`HTTP ${epRes.status}`);
    const data = await epRes.json();
    state.episodes = data.episodes || [];
    renderEpisodes();

    if (deepLink.list) {
      const opened = await openList(deepLink.list, { updateUrl: true });
      if (opened) return;
      el.playerStatus.textContent = 'Shared list not found; showing latest episode.';
      if (state.episodes.length) {
        selectEpisode(state.episodes[0], { updateUrl: false });
      }
      return;
    }

    if (!state.episodes.length) return;

    const matched = deepLink.ep
      ? state.episodes.find((ep) => ep.slug === deepLink.ep)
      : null;

    if (deepLink.ep && !matched) {
      el.playerStatus.textContent = 'Shared episode not found; showing latest episode.';
      selectEpisode(state.episodes[0], { updateUrl: false });
      return;
    }

    if (matched) {
      const matchedIdx = state.episodes.indexOf(matched);
      selectEpisode(matched, { deepLink, updateUrl: true });
      const epBtn = el.episodeList.querySelector(`.episode-item[data-idx="${matchedIdx}"]`);
      epBtn?.scrollIntoView({ block: 'nearest' });
      return;
    }

    selectEpisode(state.episodes[0], { updateUrl: false });
  } catch (err) {
    el.episodeList.innerHTML = `<div class="status">Failed to load episodes: ${escapeHtml(err.message)}</div>`;
  }
}

init();

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, resolveDbConfig } from '../lib/db.js';

describe('db config resolution', () => {
  it('prefers explicit url, falls back to local file path', () => {
    assert.deepEqual(
      resolveDbConfig({ url: 'libsql://demo.turso.io', authToken: 'tok' }),
      { url: 'libsql://demo.turso.io', authToken: 'tok' },
    );

    const local = resolveDbConfig({ dbPath: '/tmp/custom-player.db' });
    assert.equal(local.url, 'file:/tmp/custom-player.db');
    assert.equal(local.authToken, undefined);
  });
});

describe('SQLite / libSQL store', () => {
  let store;

  beforeEach(async () => {
    store = createStore({ url: ':memory:' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('archives episodes, preserves older entries and matched Spinitron IDs', async () => {
    await store.saveEpisodes([
      {
        slug: 'ep-old',
        mixcloudKey: '/bob-boilen/ep-old/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-old/',
        name: 'Old Episode',
        date: '2025-12-01',
        audioLength: 3600,
        picture: 'https://img/old.jpg',
        createdTime: '2025-12-01T15:00:00Z',
        spinitronId: '100',
        spinitronUrl: 'https://spinitron.com/WOWD/pl/100/My-Tiny-Morning-Show',
      },
    ], 1000);

    await store.saveEpisodes([
      {
        slug: 'ep-old',
        mixcloudKey: '/bob-boilen/ep-old/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-old/',
        name: 'Old Episode (Renamed)',
        date: '2025-12-01',
        audioLength: 3600,
        picture: null,
        createdTime: '2025-12-01T15:00:00Z',
        spinitronId: null,
        spinitronUrl: null,
      },
      {
        slug: 'ep-new',
        mixcloudKey: '/bob-boilen/ep-new/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-new/',
        name: 'New Episode',
        date: '2026-01-10',
        audioLength: 7200,
        picture: 'https://img/new.jpg',
        createdTime: '2026-01-10T15:00:00Z',
        spinitronId: '200',
        spinitronUrl: 'https://spinitron.com/WOWD/pl/200/My-Tiny-Morning-Show',
      },
    ], 2000);

    assert.equal(await store.getEpisodesSyncedAt(), 2000);
    const episodes = await store.getEpisodes();
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].slug, 'ep-new');
    assert.equal(episodes[1].slug, 'ep-old');
    assert.equal(episodes[1].name, 'Old Episode (Renamed)');
    assert.equal(episodes[1].spinitronId, '100');
    assert.equal(episodes[1].picture, 'https://img/old.jpg');
  });

  it('archives episode tracks and refuses to wipe non-empty tracks with an empty refresh', async () => {
    assert.equal(await store.getEpisodeTracks('missing'), null);

    await store.saveEpisodeTracks('ep-one', {
      source: 'mixcloud+spinitron',
      spinitronId: '123',
      spinitronUrl: 'https://spinitron.com/WOWD/pl/123/My-Tiny-Morning-Show',
      description: 'Cozy Saturday',
      tracks: [
        { artist: 'Miles', song: 'So What', album: 'Kind of Blue', time: '8:00 AM', offsetSeconds: 0, artwork: 'https://art/1.jpg' },
        { artist: 'Nina', song: 'Feeling Good', album: 'Spell', time: '8:05 AM', offsetSeconds: 300, artwork: null },
      ],
    }, 5000);

    const saved = await store.getEpisodeTracks('ep-one');
    assert.equal(saved.source, 'mixcloud+spinitron');
    assert.equal(saved.description, 'Cozy Saturday');
    assert.equal(saved.fetchedAt, 5000);
    assert.equal(saved.tracks.length, 2);
    assert.equal(saved.tracks[1].offsetSeconds, 300);

    await store.saveEpisodeTracks('ep-one', {
      source: 'spinitron',
      description: '',
      tracks: [],
    }, 6000);

    const afterEmpty = await store.getEpisodeTracks('ep-one');
    assert.equal(afterEmpty.tracks.length, 2);
    assert.equal(afterEmpty.source, 'mixcloud+spinitron');
    assert.equal(afterEmpty.description, 'Cozy Saturday');
    assert.equal(afterEmpty.fetchedAt, 6000);
  });

  it('looks up episodes by slug, tracklists by spinitron ID, and summarizes tracklist sync state', async () => {
    assert.equal(await store.getEpisodeBySlug('ep-one'), null);
    assert.equal(await store.getTracklistBySpinitronId('123'), null);
    assert.equal((await store.getTracklistSyncStates()).size, 0);

    await store.saveEpisodes([
      {
        slug: 'ep-one',
        mixcloudKey: '/bob-boilen/ep-one/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-one/',
        name: 'Show One',
        date: '2026-01-10',
        audioLength: 7200,
        picture: 'https://img/1.jpg',
        createdTime: '2026-01-10T15:00:00Z',
        spinitronId: '123',
        spinitronUrl: 'https://spinitron.com/WOWD/pl/123/My-Tiny-Morning-Show',
      },
      {
        slug: 'ep-empty',
        mixcloudKey: '/bob-boilen/ep-empty/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-empty/',
        name: 'Show Empty',
        date: '2026-01-17',
        audioLength: 3600,
        picture: null,
        createdTime: '2026-01-17T15:00:00Z',
        spinitronId: null,
        spinitronUrl: null,
      },
    ], 1000);

    const ep = await store.getEpisodeBySlug('ep-one');
    assert.equal(ep.slug, 'ep-one');
    assert.equal(ep.spinitronId, '123');
    assert.equal(ep.audioLength, 7200);
    assert.equal(await store.getEpisodeBySlug('missing'), null);

    await store.saveEpisodeTracks('ep-one', {
      source: 'mixcloud+spinitron',
      spinitronId: '123',
      spinitronUrl: 'https://spinitron.com/WOWD/pl/123/My-Tiny-Morning-Show',
      description: 'Cozy Saturday',
      tracks: [
        { artist: 'Miles', song: 'So What', album: 'Kind of Blue', time: '8:00 AM', offsetSeconds: 0, artwork: 'https://art/1.jpg' },
        { artist: 'Nina', song: 'Feeling Good', album: 'Spell', time: '8:05 AM', offsetSeconds: 300, artwork: null },
      ],
    }, 5000);

    await store.saveEpisodeTracks('ep-empty', {
      source: 'spinitron',
      spinitronId: null,
      spinitronUrl: null,
      description: '',
      tracks: [],
    }, 5500);

    const bySpin = await store.getTracklistBySpinitronId('123');
    assert.equal(bySpin.playlistId, '123');
    assert.equal(bySpin.spinitronUrl, 'https://spinitron.com/WOWD/pl/123/My-Tiny-Morning-Show');
    assert.equal(bySpin.description, 'Cozy Saturday');
    assert.equal(bySpin.tracks.length, 2);
    assert.equal(bySpin.tracks[0].song, 'So What');
    assert.equal(await store.getTracklistBySpinitronId('999'), null);

    const states = await store.getTracklistSyncStates();
    assert.equal(states.size, 2);
    assert.deepEqual(states.get('ep-one'), {
      slug: 'ep-one',
      source: 'mixcloud+spinitron',
      spinitronId: '123',
      trackCount: 2,
      fetchedAt: 5000,
    });
    assert.deepEqual(states.get('ep-empty'), {
      slug: 'ep-empty',
      source: 'spinitron',
      spinitronId: null,
      trackCount: 0,
      fetchedAt: 5500,
    });
  });

  it('adds, upserts, lists, and removes favorites', async () => {
    const first = await store.addFavorite({
      episodeSlug: 'ep-one',
      trackIndex: 0,
      artist: 'Miles Davis',
      song: 'Blue in Green',
      album: 'Kind of Blue',
      offsetSeconds: 0,
      episodeName: 'Show 1',
      episodeDate: '2026-01-10',
      mixcloudKey: '/bob-boilen/ep-one/',
    }, 100);
    assert.equal(first.song, 'Blue in Green');

    await store.addFavorite({
      episodeSlug: 'ep-two',
      trackIndex: 2,
      artist: 'Khruangbin',
      song: 'Time (You and I)',
      album: 'Mordechai',
      offsetSeconds: 120,
      episodeName: 'Show 2',
      episodeDate: '2026-01-17',
      mixcloudKey: '/bob-boilen/ep-two/',
    }, 200);

    await store.addFavorite({
      episodeSlug: 'ep-one',
      trackIndex: 0,
      artist: 'Miles Davis',
      song: 'Blue in Green (Remaster)',
      album: 'Kind of Blue',
      offsetSeconds: 5,
      episodeName: 'Show 1',
      episodeDate: '2026-01-10',
      mixcloudKey: '/bob-boilen/ep-one/',
    }, 300);

    const favs = await store.listFavorites();
    assert.equal(favs.length, 2);
    assert.equal(favs[0].episodeSlug, 'ep-two');
    assert.equal(favs[1].song, 'Blue in Green (Remaster)');
    assert.equal(favs[1].offsetSeconds, 5);

    assert.equal(await store.removeFavorite('ep-one', 0), true);
    assert.equal(await store.removeFavorite('ep-one', 0), false);
    assert.equal((await store.listFavorites()).length, 1);
  });

  it('creates, updates, populates, deduplicates, and deletes custom lists', async () => {
    const list = await store.createList({ name: 'Sunday Coffee', description: 'Chill cuts' }, 1000);
    assert.ok(list.id.length >= 6);
    assert.equal(list.name, 'Sunday Coffee');
    assert.equal(list.itemCount, 0);

    const updated = await store.updateList(list.id, { name: 'Morning Coffee' }, 1100);
    assert.equal(updated.name, 'Morning Coffee');
    assert.equal(updated.description, 'Chill cuts');

    const trackA = {
      episodeSlug: 'ep-one',
      trackIndex: 0,
      artist: 'Bill Evans',
      song: 'Peace Piece',
      album: 'Everybody Digs',
      offsetSeconds: 0,
      episodeName: 'Show 1',
      episodeDate: '2026-01-03',
      mixcloudKey: '/bob-boilen/ep-one/',
    };
    const trackB = {
      episodeSlug: 'ep-one',
      trackIndex: 1,
      artist: 'Stereolab',
      song: 'French Disko',
      album: 'Switched On',
      offsetSeconds: 240,
      episodeName: 'Show 1',
      episodeDate: '2026-01-03',
      mixcloudKey: '/bob-boilen/ep-one/',
    };

    await store.addListItem(list.id, trackA, 1200);
    await store.addListItem(list.id, trackB, 1300);
    const withDup = await store.addListItem(list.id, trackA, 1400);
    assert.equal(withDup.items.length, 2);
    assert.equal(withDup.items[0].song, 'Peace Piece');
    assert.equal(withDup.items[1].song, 'French Disko');

    const lists = await store.getLists();
    assert.equal(lists.length, 1);
    assert.equal(lists[0].itemCount, 2);

    assert.equal(await store.removeListItem(list.id, 'ep-one', 0, 1500), true);
    assert.equal((await store.getList(list.id)).items.length, 1);

    assert.equal(await store.deleteList(list.id), true);
    assert.equal(await store.deleteList(list.id), false);
    assert.equal(await store.getList(list.id), null);
    assert.equal(await store.addListItem('nonexistent', trackA), null);
  });

  it('persists data across store restarts on a local SQLite file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmp-tiny-morning-'));
    const dbPath = path.join(tmpDir, 'nested', 'app.db');
    try {
      const s1 = createStore({ dbPath });
      await s1.addFavorite({
        episodeSlug: 'ep-disk',
        trackIndex: 1,
        artist: 'Disk Artist',
        song: 'Disk Song',
        offsetSeconds: 42,
        mixcloudKey: '/bob-boilen/ep-disk/',
      });
      const created = await s1.createList({ name: 'Persisted List' });
      await s1.addListItem(created.id, {
        episodeSlug: 'ep-disk',
        trackIndex: 1,
        artist: 'Disk Artist',
        song: 'Disk Song',
        offsetSeconds: 42,
        mixcloudKey: '/bob-boilen/ep-disk/',
      });
      await s1.close();

      const s2 = createStore({ dbPath });
      const favs = await s2.listFavorites();
      assert.equal(favs.length, 1);
      assert.equal(favs[0].song, 'Disk Song');
      const loadedList = await s2.getList(created.id);
      assert.equal(loadedList.name, 'Persisted List');
      assert.equal(loadedList.items.length, 1);
      await s2.close();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

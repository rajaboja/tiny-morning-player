import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/db.js';
import { syncDatabase, shouldSyncEpisodeTracks, parseSyncArgs } from '../lib/sync.js';

const NOW = Date.parse('2026-02-06T15:00:00Z');

function makeEpisode(overrides = {}) {
  const slug = overrides.slug || 'ep-2026-02-04';
  const date = overrides.date ?? '2026-02-04';
  return {
    slug,
    mixcloudKey: `/bob-boilen/${slug}/`,
    mixcloudUrl: `https://www.mixcloud.com/bob-boilen/${slug}/`,
    name: `My Tiny Morning Show - ${date}`,
    date,
    audioLength: 7200,
    picture: `https://img/${slug}.jpg`,
    createdTime: `${date}T15:00:00Z`,
    spinitronId: null,
    spinitronUrl: null,
    ...overrides,
  };
}

describe('sync CLI arg parsing and tracklist decision helper', () => {
  it('parses CLI flags with defaults', () => {
    assert.deepEqual(parseSyncArgs([]), {
      full: false,
      requireRemote: false,
      maxPages: 3,
      recentDays: 30,
    });
    assert.deepEqual(
      parseSyncArgs(['--full', '--require-remote', '--max-pages=5', '--recent-days', '14']),
      {
        full: true,
        requireRemote: true,
        maxPages: 5,
        recentDays: 14,
      },
    );
  });

  it('decides incrementally which episodes need tracklist fetching', () => {
    const recentEp = makeEpisode({ slug: 'recent', date: '2026-02-04', spinitronId: '500' });
    const oldEp = makeEpisode({ slug: 'old', date: '2025-10-01', spinitronId: '100' });

    assert.equal(shouldSyncEpisodeTracks(recentEp, undefined, { full: false, now: NOW, recentDays: 30 }), true);

    assert.equal(
      shouldSyncEpisodeTracks(
        recentEp,
        { source: 'mixcloud+spinitron', spinitronId: '500', trackCount: 12, fetchedAt: NOW - 1000 },
        { full: false, now: NOW, recentDays: 30 },
      ),
      false,
    );

    assert.equal(
      shouldSyncEpisodeTracks(
        recentEp,
        { source: 'mixcloud', spinitronId: null, trackCount: 12, fetchedAt: NOW - 1000 },
        { full: false, now: NOW, recentDays: 30 },
      ),
      true,
    );

    assert.equal(
      shouldSyncEpisodeTracks(
        recentEp,
        { source: 'spinitron', spinitronId: '500', trackCount: 0, fetchedAt: NOW - 1000 },
        { full: false, now: NOW, recentDays: 30 },
      ),
      true,
    );

    assert.equal(
      shouldSyncEpisodeTracks(
        oldEp,
        { source: 'spinitron', spinitronId: '100', trackCount: 0, fetchedAt: NOW - 1000 },
        { full: false, now: NOW, recentDays: 30 },
      ),
      false,
    );

    assert.equal(
      shouldSyncEpisodeTracks(
        oldEp,
        { source: 'mixcloud+spinitron', spinitronId: '100', trackCount: 10, fetchedAt: NOW - 1000 },
        { full: true, now: NOW, recentDays: 30 },
      ),
      true,
    );
  });
});

describe('syncDatabase incremental behavior', () => {
  let store;

  beforeEach(async () => {
    store = createStore({ url: ':memory:' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('performs a quiet incremental sync with zero Spinitron or tracklist fetches when nothing is new', async () => {
    const existing = makeEpisode({
      slug: 'ep-jan-28',
      date: '2026-01-28',
      spinitronId: '1001',
      spinitronUrl: 'https://spinitron.com/WOWD/pl/1001/My-Tiny-Morning-Show',
    });
    await store.saveEpisodes([existing], NOW - 86400_000);
    await store.saveEpisodeTracks('ep-jan-28', {
      source: 'mixcloud+spinitron',
      spinitronId: '1001',
      spinitronUrl: existing.spinitronUrl,
      description: 'Archived',
      tracks: [{ artist: 'Miles', song: 'So What', album: 'KoB', time: '8:00 AM', offsetSeconds: 0, artwork: null }],
    }, NOW - 86400_000);

    let mcOpts = null;
    let spCalls = 0;
    let trackCalls = 0;

    const summary = await syncDatabase(store, {
      now: NOW,
      delayMs: 0,
      logger: { log() {}, warn() {} },
      deps: {
        fetchMixcloudEpisodes: async (opts) => {
          mcOpts = opts;
          return [existing];
        },
        fetchSpinitronEpisodes: async () => {
          spCalls++;
          return [];
        },
        fetchEpisodeTracks: async () => {
          trackCalls++;
          throw new Error('should not be called');
        },
      },
    });

    assert.equal(mcOpts.knownSlugs.has('ep-jan-28'), true);
    assert.equal(spCalls, 0);
    assert.equal(trackCalls, 0);
    assert.equal(summary.mode, 'incremental');
    assert.equal(summary.newEpisodes, 0);
    assert.equal(summary.updatedEpisodes, 0);
    assert.equal(summary.tracksFetched, 0);
    assert.equal(summary.tracksSkipped, 1);
    assert.equal(summary.errors.length, 0);
    assert.equal(await store.getEpisodesSyncedAt(), NOW);
  });

  it('syncs only newly aired episodes and enriches recent Mixcloud-only tracklists when Spinitron appears', async () => {
    const oldComplete = makeEpisode({
      slug: 'ep-old',
      date: '2025-11-05',
      spinitronId: '900',
      spinitronUrl: 'https://spinitron.com/WOWD/pl/900/My-Tiny-Morning-Show',
    });
    const recentNeedsSpin = makeEpisode({
      slug: 'ep-jan-28',
      date: '2026-01-28',
      spinitronId: null,
      spinitronUrl: null,
    });
    const brandNew = makeEpisode({
      slug: 'ep-feb-04',
      date: '2026-02-04',
    });

    await store.saveEpisodes([oldComplete, recentNeedsSpin], NOW - 86400_000);
    await store.saveEpisodeTracks('ep-old', {
      source: 'mixcloud+spinitron',
      spinitronId: '900',
      spinitronUrl: oldComplete.spinitronUrl,
      description: 'Old complete',
      tracks: [{ artist: 'A', song: 'Old Song', album: 'Old LP', time: '8:00 AM', offsetSeconds: 0, artwork: null }],
    }, NOW - 86400_000);
    await store.saveEpisodeTracks('ep-jan-28', {
      source: 'mixcloud',
      spinitronId: null,
      spinitronUrl: null,
      description: 'MC only',
      tracks: [{ artist: 'B', song: 'Recent Song', album: '', time: '', offsetSeconds: 10, artwork: null }],
    }, NOW - 86400_000);

    let spOpts = null;
    const fetchedTracks = [];

    const summary = await syncDatabase(store, {
      now: NOW,
      delayMs: 0,
      logger: { log() {}, warn() {} },
      deps: {
        fetchMixcloudEpisodes: async () => [brandNew, recentNeedsSpin],
        fetchSpinitronEpisodes: async (opts) => {
          spOpts = opts;
          return [
            { spinitronId: '2002', spinitronUrl: 'https://spinitron.com/WOWD/pl/2002/My-Tiny-Morning-Show', date: '2026-02-04' },
            { spinitronId: '2001', spinitronUrl: 'https://spinitron.com/WOWD/pl/2001/My-Tiny-Morning-Show', date: '2026-01-28' },
          ];
        },
        fetchEpisodeTracks: async (slug, spinitronId) => {
          fetchedTracks.push({ slug, spinitronId });
          return {
            source: 'mixcloud+spinitron',
            slug,
            spinitronId,
            spinitronUrl: `https://spinitron.com/WOWD/pl/${spinitronId}/My-Tiny-Morning-Show`,
            description: `Synced ${slug}`,
            tracks: [{ artist: 'Artist', song: `Song ${slug}`, album: 'Album', time: '8:00 AM', offsetSeconds: 0, artwork: null }],
          };
        },
      },
    });

    assert.equal(spOpts.stopBeforeDate, '2026-01-28');
    assert.equal(summary.newEpisodes, 1);
    assert.equal(summary.updatedEpisodes, 1);
    assert.equal(summary.tracksFetched, 2);
    assert.equal(summary.tracksSkipped, 1);
    assert.deepEqual(fetchedTracks, [
      { slug: 'ep-feb-04', spinitronId: '2002' },
      { slug: 'ep-jan-28', spinitronId: '2001' },
    ]);

    const episodes = await store.getEpisodes();
    assert.equal(episodes.length, 3);
    assert.equal(episodes.find((e) => e.slug === 'ep-feb-04').spinitronId, '2002');
    assert.equal(episodes.find((e) => e.slug === 'ep-jan-28').spinitronId, '2001');

    const enriched = await store.getEpisodeTracks('ep-jan-28');
    assert.equal(enriched.source, 'mixcloud+spinitron');
    assert.equal(enriched.tracks[0].album, 'Album');
  });

  it('continues past individual tracklist failures and supports full refresh mode', async () => {
    const ep1 = makeEpisode({ slug: 'ep-1', date: '2026-02-04', spinitronId: '301' });
    const ep2 = makeEpisode({ slug: 'ep-2', date: '2026-01-28', spinitronId: '302' });
    await store.saveEpisodes([ep1, ep2], NOW - 86400_000);
    await store.saveEpisodeTracks('ep-1', {
      source: 'mixcloud+spinitron',
      spinitronId: '301',
      spinitronUrl: null,
      description: 'Existing 1',
      tracks: [{ artist: 'A', song: 'S1', album: '', time: '', offsetSeconds: 0, artwork: null }],
    }, NOW - 86400_000);
    await store.saveEpisodeTracks('ep-2', {
      source: 'mixcloud+spinitron',
      spinitronId: '302',
      spinitronUrl: null,
      description: 'Existing 2',
      tracks: [{ artist: 'B', song: 'S2', album: '', time: '', offsetSeconds: 0, artwork: null }],
    }, NOW - 86400_000);

    let mcOpts = null;
    const summary = await syncDatabase(store, {
      full: true,
      now: NOW,
      delayMs: 0,
      logger: { log() {}, warn() {} },
      deps: {
        fetchMixcloudEpisodes: async (opts) => {
          mcOpts = opts;
          return [ep1, ep2];
        },
        fetchSpinitronEpisodes: async () => [],
        fetchEpisodeTracks: async (slug) => {
          if (slug === 'ep-1') throw new Error('Mixcloud 503');
          return {
            source: 'mixcloud+spinitron',
            slug,
            spinitronId: '302',
            spinitronUrl: null,
            description: 'Refreshed 2',
            tracks: [{ artist: 'B', song: 'S2 Updated', album: 'New', time: '8:00 AM', offsetSeconds: 0, artwork: null }],
          };
        },
      },
    });

    assert.equal(mcOpts.knownSlugs, null);
    assert.equal(summary.mode, 'full');
    assert.equal(summary.tracksAttempted, 2);
    assert.equal(summary.tracksFetched, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].slug, 'ep-1');

    const refreshed = await store.getEpisodeTracks('ep-2');
    assert.equal(refreshed.tracks[0].song, 'S2 Updated');
  });
});

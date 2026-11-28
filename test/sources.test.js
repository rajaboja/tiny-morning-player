import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCache,
  decodeHtml,
  parseDateFromText,
  parseTimeToMinutes,
  normalizeMatchKey,
  fetchMixcloudEpisodes,
  fetchSpinitronEpisodes,
  fetchEpisodeTracks,
  getEpisodes,
  getTracklist,
  getMixcloudTracklist,
  getEpisodeTracks,
} from '../lib/sources.js';
import { createStore } from '../lib/db.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

describe('sources parsing helpers', () => {
  it('decodes HTML entities and non-breaking spaces', () => {
    assert.equal(decodeHtml('Rock &amp; Roll &quot;Live&quot; &#39;26'), 'Rock & Roll "Live" \'26');
    assert.equal(decodeHtml('A&nbsp;B&#160;C\u202fD&#8212;E'), 'A B C D—E');
    assert.equal(decodeHtml(''), '');
    assert.equal(decodeHtml(null), '');
  });

  it('parses dates from titles, slugs, and ISO strings', () => {
    assert.equal(parseDateFromText('My Tiny Morning Show - January 3rd, 2026'), '2026-01-03');
    assert.equal(parseDateFromText('my-tiny-morning-show-sept-14-2025'), '2025-09-14');
    assert.equal(parseDateFromText('Episode 2026-02-28 Special'), '2026-02-28');
    assert.equal(parseDateFromText('No date here'), null);
    assert.equal(parseDateFromText(''), null);
  });

  it('parses 12-hour clock times to minutes since midnight', () => {
    assert.equal(parseTimeToMinutes('8:00 AM'), 480);
    assert.equal(parseTimeToMinutes('12:00 AM'), 0);
    assert.equal(parseTimeToMinutes('12:30 PM'), 750);
    assert.equal(parseTimeToMinutes('1:05 PM'), 785);
    assert.equal(parseTimeToMinutes('8:15&#160;AM'), 495);
    assert.equal(parseTimeToMinutes('invalid'), null);
  });

  it('normalizes song match keys', () => {
    assert.equal(normalizeMatchKey("Don't Stop! (2026 Mix)"), 'dontstop2026mix');
    assert.equal(normalizeMatchKey(''), '');
  });
});

describe('sources data fetching and merging', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearCache();
  });

  it('matches Mixcloud episodes to Spinitron playlists by date and respects cache/refresh', async () => {
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount++;
      const s = String(url);
      if (s.includes('api.mixcloud.com') && !s.includes('page=2')) {
        return jsonResponse({
          data: [
            {
              key: '/bob-boilen/ep-jan-10/',
              url: 'https://www.mixcloud.com/bob-boilen/ep-jan-10/',
              name: 'My Tiny Morning Show - Jan 10, 2026',
              slug: 'ep-jan-10',
              audio_length: 7200,
              pictures: { large: 'https://img/jan10.jpg' },
              created_time: '2026-01-10T15:00:00Z',
            },
          ],
          paging: { next: 'https://api.mixcloud.com/bob-boilen/cloudcasts/?page=2' },
        });
      }
      if (s.includes('api.mixcloud.com') && s.includes('page=2')) {
        return jsonResponse({
          data: [
            {
              key: '/bob-boilen/ep-unmatched/',
              url: 'https://www.mixcloud.com/bob-boilen/ep-unmatched/',
              name: 'Bonus Mix',
              slug: 'ep-unmatched',
              audio_length: 3600,
              pictures: { medium: 'https://img/bonus.jpg' },
              created_time: '2026-01-05T15:00:00Z',
            },
          ],
          paging: {},
        });
      }
      if (s.includes('spinitron.com/WOWD/show/')) {
        if (s.includes('page=2')) return htmlResponse('<html><body></body></html>');
        return htmlResponse(`
          <div>
            <a href="/WOWD/pl/21234567/My-Tiny-Morning-Show">Show</a>
            <span>Jan 10th, 2026</span>
          </div>
        `);
      }
      throw new Error(`Unexpected fetch URL: ${s}`);
    };

    const first = await getEpisodes();
    assert.equal(first.length, 2);
    assert.equal(first[0].date, '2026-01-10');
    assert.equal(first[0].spinitronId, '21234567');
    assert.equal(first[0].spinitronUrl, 'https://spinitron.com/WOWD/pl/21234567/My-Tiny-Morning-Show');
    assert.equal(first[1].date, '2026-01-05');
    assert.equal(first[1].spinitronId, null);
    assert.equal(first[1].picture, 'https://img/bonus.jpg');

    const countAfterFirst = fetchCount;
    const cached = await getEpisodes();
    assert.equal(fetchCount, countAfterFirst);
    assert.deepEqual(cached, first);

    await getEpisodes(true);
    assert.ok(fetchCount > countAfterFirst);
  });

  it('scrapes Spinitron tracklist HTML including midnight rollover and malformed rows', async () => {
    await assert.rejects(() => getTracklist('not-a-number'), /Invalid playlist ID/);

    const spinitronHtml = `
      <html><body>
        <p>11:30 PM – 1:30 AM</p>
        <div class="description">Late &amp; <b>Great</b> Show</div>
        <table>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;Artist One&quot;,&quot;s&quot;:&quot;Song One&quot;,&quot;r&quot;:&quot;Album One&quot;,&quot;i&quot;:&quot;ISRC1&quot;}">
            <td class="spin-time">11:35\u202fPM</td>
            <td class="spin-art"><img src="https://art/one.jpg"></td>
          </tr>
          <tr class="spin-item" data-spin="not-valid-json">
            <td class="spin-time">11:40 PM</td>
          </tr>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;Artist Two&quot;,&quot;s&quot;:&quot;After Midnight&quot;,&quot;r&quot;:&quot;Album Two&quot;}">
            <td class="spin-time">12:15\u00a0AM</td>
            <td class="spin-art"></td>
          </tr>
        </table>
      </body></html>
    `;

    let hits = 0;
    globalThis.fetch = async () => {
      hits++;
      return htmlResponse(spinitronHtml);
    };

    const result = await getTracklist('987654');
    assert.equal(result.showStartTime, '11:30 PM');
    assert.equal(result.description, 'Late & Great Show');
    assert.equal(result.tracks.length, 2);
    assert.deepEqual(result.tracks[0], {
      artist: 'Artist One',
      song: 'Song One',
      album: 'Album One',
      isrc: 'ISRC1',
      time: '11:35 PM',
      offsetSeconds: 5 * 60,
      artwork: 'https://art/one.jpg',
    });
    assert.equal(result.tracks[1].offsetSeconds, 45 * 60);
    assert.equal(result.tracks[1].artwork, null);

    await getTracklist('987654');
    assert.equal(hits, 1);
  });

  it('parses Mixcloud GraphQL track sections and validates slug', async () => {
    await assert.rejects(() => getMixcloudTracklist('bad slug!'), /Invalid Mixcloud slug/);

    globalThis.fetch = async () => jsonResponse({
      data: {
        cloudcastLookup: {
          name: 'Show',
          description: '  Morning vibes  ',
          audioLength: 3600,
          sections: [
            { __typename: 'ChapterSection', chapter: 'Intro' },
            { __typename: 'TrackSection', startSeconds: -5, artistName: 'A1', songName: 'S1' },
            { __typename: 'TrackSection', startSeconds: 180, artistName: 'A2', songName: 'S2' },
            { __typename: 'TrackSection', startSeconds: 200, artistName: '', songName: '' },
          ],
        },
      },
    });

    const mc = await getMixcloudTracklist('valid-slug');
    assert.equal(mc.description, 'Morning vibes');
    assert.equal(mc.tracks.length, 2);
    assert.equal(mc.tracks[0].offsetSeconds, 0);
    assert.equal(mc.tracks[1].offsetSeconds, 180);
  });

  it('merges Mixcloud + Spinitron metadata and repairs duplicate Mixcloud timestamps', async () => {
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('graphql')) {
        return jsonResponse({
          data: {
            cloudcastLookup: {
              name: 'Show',
              description: 'Mixcloud desc',
              audioLength: 3600,
              sections: [
                { __typename: 'TrackSection', startSeconds: 60, artistName: 'Artist A', songName: 'First Song' },
                { __typename: 'TrackSection', startSeconds: 60, artistName: 'Artist B', songName: 'Second Song!' },
              ],
            },
          },
        });
      }
      return htmlResponse(`
        <p>8:00 AM - 10:00 AM</p>
        <table>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;Artist A&quot;,&quot;s&quot;:&quot;First Song&quot;,&quot;r&quot;:&quot;First Album&quot;}">
            <td class="spin-time">8:01 AM</td>
            <td class="spin-art"><img src="https://art/a.jpg"></td>
          </tr>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;Artist B&quot;,&quot;s&quot;:&quot;Second Song&quot;,&quot;r&quot;:&quot;Second Album&quot;}">
            <td class="spin-time">8:05 AM</td>
            <td class="spin-art"><img src="https://art/b.jpg"></td>
          </tr>
        </table>
      `);
    };

    const merged = await getEpisodeTracks('ep-merged', '11111');
    assert.equal(merged.source, 'mixcloud+spinitron');
    assert.equal(merged.description, 'Mixcloud desc');
    assert.equal(merged.tracks.length, 2);
    assert.equal(merged.tracks[0].offsetSeconds, 60);
    assert.equal(merged.tracks[0].album, 'First Album');
    assert.equal(merged.tracks[0].artwork, 'https://art/a.jpg');
    assert.equal(merged.tracks[1].offsetSeconds, 300);
    assert.equal(merged.tracks[1].album, 'Second Album');
    assert.equal(merged.tracks[1].time, '8:05 AM');
  });

  it('falls back to Mixcloud-only, Spinitron-only, and throws if both fail', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('graphql')) {
        return jsonResponse({
          data: {
            cloudcastLookup: {
              name: 'Show',
              description: 'MC only',
              audioLength: 1800,
              sections: [
                { __typename: 'TrackSection', startSeconds: 10, artistName: 'Solo', songName: 'Track' },
              ],
            },
          },
        });
      }
      return new Response('down', { status: 503 });
    };

    const mcOnly = await getEpisodeTracks('mc-only', '22222');
    assert.equal(mcOnly.source, 'mixcloud');
    assert.equal(mcOnly.tracks.length, 1);

    clearCache();
    globalThis.fetch = async (url) => {
      if (String(url).includes('graphql')) {
        return new Response('down', { status: 500 });
      }
      return htmlResponse(`
        <p>8:00 AM - 10:00 AM</p>
        <div class="description">Spinitron desc</div>
        <table>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;Spin Artist&quot;,&quot;s&quot;:&quot;Spin Song&quot;,&quot;r&quot;:&quot;Spin Album&quot;}">
            <td class="spin-time">8:02 AM</td>
          </tr>
        </table>
      `);
    };

    const spOnly = await getEpisodeTracks('sp-only', '33333');
    assert.equal(spOnly.source, 'spinitron');
    assert.equal(spOnly.description, 'Spinitron desc');
    assert.equal(spOnly.tracks[0].song, 'Spin Song');

    clearCache();
    globalThis.fetch = async () => new Response('down', { status: 500 });
    await assert.rejects(
      () => getEpisodeTracks('both-down', '44444'),
      /Failed to load tracklist from Mixcloud and Spinitron/,
    );
  });
});

describe('sources persistent archive integration', () => {
  const originalFetch = globalThis.fetch;
  let store;

  beforeEach(async () => {
    clearCache();
    store = createStore({ url: ':memory:' });
    await store.init();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearCache();
    await store.close();
  });

  it('hydrates episodes from store on cold start, retains older archived episodes, and falls back on upstream errors', async () => {
    await store.saveEpisodes([
      {
        slug: 'ep-archive-old',
        mixcloudKey: '/bob-boilen/ep-archive-old/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-archive-old/',
        name: 'My Tiny Morning Show - Jan 1, 2025',
        date: '2025-01-01',
        audioLength: 3600,
        picture: null,
        createdTime: '2025-01-01T15:00:00Z',
        spinitronId: '555',
        spinitronUrl: 'https://spinitron.com/WOWD/pl/555/My-Tiny-Morning-Show',
      },
    ], Date.now());

    let fetchCalls = 0;
    globalThis.fetch = async (url) => {
      fetchCalls++;
      const s = String(url);
      if (s.includes('api.mixcloud.com')) {
        return jsonResponse({
          data: [
            {
              key: '/bob-boilen/ep-fresh/',
              url: 'https://www.mixcloud.com/bob-boilen/ep-fresh/',
              name: 'My Tiny Morning Show - Feb 1, 2026',
              slug: 'ep-fresh',
              audio_length: 7200,
              pictures: { large: 'https://img/fresh.jpg' },
              created_time: '2026-02-01T15:00:00Z',
            },
          ],
          paging: {},
        });
      }
      return htmlResponse('<html><body></body></html>');
    };

    const hydrated = await getEpisodes(false, store);
    assert.equal(fetchCalls, 0);
    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].slug, 'ep-archive-old');

    const refreshed = await getEpisodes(true, store);
    assert.ok(fetchCalls > 0);
    assert.equal(refreshed.length, 2);
    assert.deepEqual(refreshed.map((e) => e.slug), ['ep-fresh', 'ep-archive-old']);

    clearCache();
    globalThis.fetch = async () => new Response('down', { status: 503 });
    const fallback = await getEpisodes(true, store);
    assert.equal(fallback.length, 2);
    assert.equal(fallback[0].slug, 'ep-fresh');
  });

  it('archives episode tracklists, serves from store across memory clears, and falls back when upstream is down', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async (url) => {
      fetchCalls++;
      if (String(url).includes('graphql')) {
        return jsonResponse({
          data: {
            cloudcastLookup: {
              name: 'Show',
              description: 'Persisted desc',
              audioLength: 3600,
              sections: [
                { __typename: 'TrackSection', startSeconds: 15, artistName: 'Arc Artist', songName: 'Arc Song' },
              ],
            },
          },
        });
      }
      return new Response('down', { status: 503 });
    };

    const first = await getEpisodeTracks('ep-persisted', null, store);
    assert.equal(first.tracks.length, 1);
    assert.equal(fetchCalls, 1);

    clearCache();
    const fromStore = await getEpisodeTracks('ep-persisted', null, store);
    assert.equal(fetchCalls, 1);
    assert.equal(fromStore.tracks[0].song, 'Arc Song');
    assert.equal(fromStore.fetchedAt, undefined);

    await store.saveEpisodeTracks('ep-persisted', first, 1);
    clearCache();
    globalThis.fetch = async () => new Response('down', { status: 500 });
    const fallback = await getEpisodeTracks('ep-persisted', null, store);
    assert.equal(fallback.tracks.length, 1);
    assert.equal(fallback.tracks[0].song, 'Arc Song');
  });
});

describe('incremental upstream fetchers', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearCache();
  });

  it('stops Mixcloud pagination once a known slug is encountered', async () => {
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      const s = String(url);
      requestedUrls.push(s);
      if (!s.includes('page=2')) {
        return jsonResponse({
          data: [
            {
              key: '/bob-boilen/ep-new/',
              url: 'https://www.mixcloud.com/bob-boilen/ep-new/',
              name: 'My Tiny Morning Show - Feb 4, 2026',
              slug: 'ep-new',
              audio_length: 7200,
              pictures: { large: 'https://img/new.jpg' },
              created_time: '2026-02-05T15:00:00Z',
            },
            {
              key: '/bob-boilen/ep-known/',
              url: 'https://www.mixcloud.com/bob-boilen/ep-known/',
              name: 'My Tiny Morning Show - Jan 28, 2026',
              slug: 'ep-known',
              audio_length: 7200,
              pictures: { large: 'https://img/known.jpg' },
              created_time: '2026-01-29T15:00:00Z',
            },
          ],
          paging: { next: 'https://api.mixcloud.com/bob-boilen/cloudcasts/?page=2' },
        });
      }
      throw new Error('Should not fetch page 2 when known slug was seen on page 1');
    };

    const items = await fetchMixcloudEpisodes({
      maxPages: 3,
      knownSlugs: new Set(['ep-known']),
    });
    assert.equal(requestedUrls.length, 1);
    assert.deepEqual(items.map((e) => e.slug), ['ep-new', 'ep-known']);
  });

  it('stops Spinitron pagination once stopBeforeDate is reached', async () => {
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      const s = String(url);
      requestedUrls.push(s);
      if (!s.includes('page=2')) {
        return htmlResponse(`
          <div>
            <a href="/WOWD/pl/3001/My-Tiny-Morning-Show">Show</a><span>Feb 4, 2026</span>
            <a href="/WOWD/pl/3000/My-Tiny-Morning-Show">Show</a><span>Jan 28, 2026</span>
          </div>
        `);
      }
      throw new Error('Should not fetch page 2 once stopBeforeDate is reached');
    };

    const items = await fetchSpinitronEpisodes({
      maxPages: 3,
      stopBeforeDate: '2026-01-28',
    });
    assert.equal(requestedUrls.length, 1);
    assert.equal(items.length, 2);
    assert.equal(items[0].spinitronId, '3001');
  });

  it('fetchEpisodeTracks fetches and merges Mixcloud and Spinitron directly', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('graphql')) {
        return jsonResponse({
          data: {
            cloudcastLookup: {
              name: 'Show',
              description: 'Fresh episode',
              audioLength: 3600,
              sections: [
                { __typename: 'TrackSection', startSeconds: 30, artistName: 'A', songName: 'Song A' },
              ],
            },
          },
        });
      }
      return htmlResponse(`
        <p>8:00 AM - 10:00 AM</p>
        <table>
          <tr class="spin-item" data-spin="{&quot;a&quot;:&quot;A&quot;,&quot;s&quot;:&quot;Song A&quot;,&quot;r&quot;:&quot;Album A&quot;}">
            <td class="spin-time">8:01 AM</td>
            <td class="spin-art"><img src="https://art/a.jpg"></td>
          </tr>
        </table>
      `);
    };

    const merged = await fetchEpisodeTracks('ep-fresh', '55555');
    assert.equal(merged.source, 'mixcloud+spinitron');
    assert.equal(merged.spinitronId, '55555');
    assert.equal(merged.tracks.length, 1);
    assert.equal(merged.tracks[0].album, 'Album A');
  });
});

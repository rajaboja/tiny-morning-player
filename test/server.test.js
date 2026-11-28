import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, pickPreviewImage, getCanonicalOrigin } from '../server.js';
import { createStore } from '../lib/db.js';

const SAMPLE_EPISODES = [
  {
    mixcloudKey: '/bob-boilen/ep-one/',
    mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-one/',
    name: 'Morning Show <Special> & "Friends"',
    slug: 'ep-one',
    date: '2026-01-10',
    audioLength: 7200,
    picture: 'https://img.example/ep-one.jpg',
    spinitronId: '12345',
    spinitronUrl: 'https://spinitron.com/WOWD/pl/12345/My-Tiny-Morning-Show',
  },
];

const SAMPLE_TRACKS = {
  source: 'mixcloud+spinitron',
  slug: 'ep-one',
  spinitronId: '12345',
  description: 'A cozy show',
  tracks: [
    {
      artist: 'First Artist',
      song: 'Opening Track',
      album: 'First LP',
      time: '8:00 AM',
      offsetSeconds: 0,
      artwork: 'https://cdn.example/placeholders/default.png',
    },
    {
      artist: 'Second & Band',
      song: 'Sun "Rise"',
      album: 'Dawn <LP>',
      time: '8:03 AM',
      offsetSeconds: 185,
      artwork: 'https://cdn.example/art/track2.jpg',
    },
    {
      artist: 'Third Artist',
      song: 'Vector Art Song',
      album: '',
      time: '8:08 AM',
      offsetSeconds: 480,
      artwork: 'https://cdn.example/art/icon.svg?v=2',
    },
  ],
};

async function startTestServer(overrides = {}) {
  const store = overrides.store ?? createStore({ url: ':memory:' });
  const server = createServer({ store, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (!overrides.store) await store.close();
    },
  };
}

describe('server helper functions', () => {
  it('picks raster track artwork and skips svg or placeholder art', () => {
    assert.equal(pickPreviewImage('https://a.com/cover.jpg', 'https://a.com/ep.jpg'), 'https://a.com/cover.jpg');
    assert.equal(pickPreviewImage('https://a.com/cover.svg?x=1', 'https://a.com/ep.jpg'), 'https://a.com/ep.jpg');
    assert.equal(pickPreviewImage('https://a.com/placeholders/spin.png', 'https://a.com/ep.jpg'), 'https://a.com/ep.jpg');
    assert.equal(pickPreviewImage(null, null), null);
  });

  it('derives canonical origin from forwarded headers', () => {
    assert.equal(
      getCanonicalOrigin({ headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'show.example.com, proxy', host: 'internal:3000' } }),
      'https://show.example.com',
    );
    assert.equal(
      getCanonicalOrigin({ headers: { 'x-forwarded-proto': 'javascript', host: 'localhost:3000' } }),
      'http://localhost:3000',
    );
  });
});

describe('HTTP API and SSR share meta', () => {
  let srv;
  let episodesCalls = 0;
  let lastTracksArgs;
  let lastTracklistArg;

  before(async () => {
    srv = await startTestServer({
      getEpisodes: async () => {
        episodesCalls++;
        return SAMPLE_EPISODES;
      },
      getEpisodeTracks: async (slug, spinitronId) => {
        lastTracksArgs = { slug, spinitronId };
        return SAMPLE_TRACKS;
      },
      getTracklist: async (id) => {
        lastTracklistArg = id;
        return { playlistId: id, tracks: SAMPLE_TRACKS.tracks };
      },
    });
  });

  after(async () => {
    await srv.close();
  });

  it('responds to /health', async () => {
    const res = await fetch(`${srv.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('serves /api/episodes from the episode provider', async () => {
    const beforeCalls = episodesCalls;
    const r1 = await fetch(`${srv.baseUrl}/api/episodes`);
    assert.equal(r1.status, 200);
    const body1 = await r1.json();
    assert.equal(body1.episodes.length, 1);
    assert.equal(episodesCalls, beforeCalls + 1);
  });

  it('serves /api/episodes/:slug/tracks and /api/tracks/:id', async () => {
    const r1 = await fetch(`${srv.baseUrl}/api/episodes/ep-one/tracks?spinitronId=12345`);
    assert.equal(r1.status, 200);
    assert.deepEqual(lastTracksArgs, { slug: 'ep-one', spinitronId: '12345' });
    const data1 = await r1.json();
    assert.equal(data1.tracks.length, 3);

    const r2 = await fetch(`${srv.baseUrl}/api/tracks/999`);
    assert.equal(r2.status, 200);
    assert.equal(lastTracklistArg, '999');

    const bad = await fetch(`${srv.baseUrl}/api/tracks/abc`);
    assert.equal(bad.status, 404);
  });

  it('serves static assets, rejects non-GET, and prevents reading outside public/', async () => {
    const index = await fetch(`${srv.baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);

    const libJs = await fetch(`${srv.baseUrl}/lib.js`);
    assert.equal(libJs.status, 200);
    assert.match(libJs.headers.get('content-type'), /application\/javascript/);

    const css = await fetch(`${srv.baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const post = await fetch(`${srv.baseUrl}/api/episodes`, { method: 'POST' });
    assert.equal(post.status, 405);

    const traversal = await fetch(`${srv.baseUrl}/../package.json`);
    assert.ok(traversal.status === 403 || traversal.status === 404);
    const traversalBody = await traversal.text();
    assert.doesNotMatch(traversalBody, /tiny-morning-player/);
  });

  it('injects escaped OG/Twitter meta tags for episode share URLs', async () => {
    const res = await fetch(`${srv.baseUrl}/?ep=ep-one`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'player.example.com' },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Morning Show &lt;Special&gt; &amp; &quot;Friends&quot; · My Tiny Morning Show<\/title>/);
    assert.match(html, /property="og:type" content="website"/);
    assert.match(html, /property="og:url" content="https:\/\/player\.example\.com\/\?ep=ep-one"/);
    assert.match(html, /property="og:image" content="https:\/\/img\.example\/ep-one\.jpg"/);
  });

  it('injects track meta tags for ?track=N and ?t=S and skips SVG/placeholder art', async () => {
    const resTrack = await fetch(`${srv.baseUrl}/?ep=ep-one&track=2`);
    const htmlTrack = await resTrack.text();
    assert.match(htmlTrack, /property="og:type" content="music\.song"/);
    assert.match(htmlTrack, /property="og:title" content="Second &amp; Band — Sun &quot;Rise&quot;"/);
    assert.match(htmlTrack, /at 3:05\) · Dawn &lt;LP&gt;/);
    assert.match(htmlTrack, /property="og:image" content="https:\/\/cdn\.example\/art\/track2\.jpg"/);

    const resTime = await fetch(`${srv.baseUrl}/?ep=ep-one&t=210`);
    const htmlTime = await resTime.text();
    assert.match(htmlTime, /property="og:url" content="http:\/\/127\.0\.0\.1:\d+\/\?ep=ep-one&amp;track=2"/);

    const resPlaceholder = await fetch(`${srv.baseUrl}/?ep=ep-one&track=1`);
    assert.match(await resPlaceholder.text(), /property="og:image" content="https:\/\/img\.example\/ep-one\.jpg"/);

    const resSvg = await fetch(`${srv.baseUrl}/?ep=ep-one&track=3`);
    assert.match(await resSvg.text(), /property="og:image" content="https:\/\/img\.example\/ep-one\.jpg"/);
  });

  it('falls back to plain index.html for invalid or unknown ep slugs', async () => {
    const badSlug = await fetch(`${srv.baseUrl}/?ep=bad_slug!`);
    assert.equal(badSlug.status, 200);
    assert.doesNotMatch(await badSlug.text(), /property="og:title"/);

    const unknown = await fetch(`${srv.baseUrl}/?ep=does-not-exist`);
    assert.equal(unknown.status, 200);
    assert.doesNotMatch(await unknown.text(), /property="og:title"/);
  });
});

describe('HTTP error and timeout handling', () => {
  it('returns 500 JSON when API handler throws and falls back cleanly on slow SSR metadata', async () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    const srv = await startTestServer({
      getEpisodes: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('upstream boom');
      },
      metaTimeoutMs: 15,
    });
    try {
      const apiRes = await fetch(`${srv.baseUrl}/api/episodes`);
      assert.equal(apiRes.status, 500);
      assert.deepEqual(await apiRes.json(), { error: 'upstream boom' });

      const ssrRes = await fetch(`${srv.baseUrl}/?ep=ep-one`);
      assert.equal(ssrRes.status, 200);
      assert.doesNotMatch(await ssrRes.text(), /property="og:title"/);
    } finally {
      console.error = originalConsoleError;
      await srv.close();
    }
  });
});

describe('Favorites and Lists REST API + SSR list share meta', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      getEpisodes: async () => SAMPLE_EPISODES,
      getEpisodeTracks: async () => SAMPLE_TRACKS,
    });
  });

  after(async () => {
    await srv.close();
  });

  it('creates, lists, validates, and deletes favorites', async () => {
    const empty = await fetch(`${srv.baseUrl}/api/favorites`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { favorites: [] });

    const invalid = await fetch(`${srv.baseUrl}/api/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeSlug: 'bad slug!', trackIndex: 0 }),
    });
    assert.equal(invalid.status, 400);

    const badJson = await fetch(`${srv.baseUrl}/api/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(badJson.status, 400);

    const created = await fetch(`${srv.baseUrl}/api/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodeSlug: 'ep-one',
        trackIndex: 1,
        artist: 'Second & Band',
        song: 'Sun "Rise"',
        album: 'Dawn <LP>',
        time: '8:03 AM',
        offsetSeconds: 185,
        artwork: 'https://cdn.example/art/track2.jpg',
        episodeName: 'Morning Show',
        episodeDate: '2026-01-10',
        mixcloudKey: '/bob-boilen/ep-one/',
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.favorite.song, 'Sun "Rise"');

    const listed = await (await fetch(`${srv.baseUrl}/api/favorites`)).json();
    assert.equal(listed.favorites.length, 1);

    const del = await fetch(`${srv.baseUrl}/api/favorites/ep-one/1`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { deleted: true });

    const afterDel = await (await fetch(`${srv.baseUrl}/api/favorites`)).json();
    assert.equal(afterDel.favorites.length, 0);
  });

  it('supports full list lifecycle, item add/remove, validation, and SSR share meta', async () => {
    const missing = await fetch(`${srv.baseUrl}/api/lists/no-such-list`);
    assert.equal(missing.status, 404);

    const badName = await fetch(`${srv.baseUrl}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(badName.status, 400);

    const createRes = await fetch(`${srv.baseUrl}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rainy & <Chill>', description: 'Coffee tunes' }),
    });
    assert.equal(createRes.status, 201);
    const { list } = await createRes.json();
    assert.ok(list.id);

    const addSvgItem = await fetch(`${srv.baseUrl}/api/lists/${list.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodeSlug: 'ep-one',
        trackIndex: 2,
        artist: 'Third Artist',
        song: 'Vector Art Song',
        offsetSeconds: 480,
        artwork: 'https://cdn.example/art/icon.svg',
        mixcloudKey: '/bob-boilen/ep-one/',
      }),
    });
    assert.equal(addSvgItem.status, 201);

    const addRasterItem = await fetch(`${srv.baseUrl}/api/lists/${list.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodeSlug: 'ep-one',
        trackIndex: 1,
        artist: 'Second & Band',
        song: 'Sun "Rise"',
        offsetSeconds: 185,
        artwork: 'https://cdn.example/art/track2.jpg',
        mixcloudKey: '/bob-boilen/ep-one/',
      }),
    });
    assert.equal(addRasterItem.status, 201);
    const afterAdd = await addRasterItem.json();
    assert.equal(afterAdd.list.items.length, 2);

    const ssrRes = await fetch(`${srv.baseUrl}/?list=${list.id}`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'player.example.com' },
    });
    assert.equal(ssrRes.status, 200);
    const ssrHtml = await ssrRes.text();
    assert.match(ssrHtml, /<title>Rainy &amp; &lt;Chill&gt; · My Tiny Morning Show<\/title>/);
    assert.match(ssrHtml, /property="og:type" content="music\.playlist"/);
    assert.match(ssrHtml, /property="og:description" content="2 tracks · Coffee tunes · My Tiny Morning Show"/);
    assert.match(ssrHtml, /property="og:image" content="https:\/\/cdn\.example\/art\/track2\.jpg"/);
    assert.match(ssrHtml, new RegExp(`property="og:url" content="https://player\\.example\\.com/\\?list=${list.id}"`));

    const ssrUnknown = await fetch(`${srv.baseUrl}/?list=does-not-exist`);
    assert.equal(ssrUnknown.status, 200);
    assert.doesNotMatch(await ssrUnknown.text(), /property="og:title"/);

    const patchRes = await fetch(`${srv.baseUrl}/api/lists/${list.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sunny Morning' }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).list.name, 'Sunny Morning');

    const delItem = await fetch(`${srv.baseUrl}/api/lists/${list.id}/items/ep-one/1`, { method: 'DELETE' });
    assert.equal(delItem.status, 200);
    assert.deepEqual(await delItem.json(), { deleted: true });

    const allLists = await (await fetch(`${srv.baseUrl}/api/lists`)).json();
    assert.equal(allLists.lists.length, 1);
    assert.equal(allLists.lists[0].itemCount, 1);

    const delList = await fetch(`${srv.baseUrl}/api/lists/${list.id}`, { method: 'DELETE' });
    assert.equal(delList.status, 200);
    assert.deepEqual(await delList.json(), { deleted: true });

    const afterDelete = await fetch(`${srv.baseUrl}/api/lists/${list.id}`);
    assert.equal(afterDelete.status, 404);
  });
});

describe('DB-only reads without upstream API calls', () => {
  const originalFetch = globalThis.fetch;
  let srv;
  let outboundCalls;

  before(async () => {
    srv = await startTestServer();
    await srv.store.saveEpisodes([
      ...SAMPLE_EPISODES,
      {
        mixcloudKey: '/bob-boilen/ep-no-tracks/',
        mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-no-tracks/',
        name: 'Unindexed Episode',
        slug: 'ep-no-tracks',
        date: '2026-01-03',
        audioLength: 3600,
        picture: null,
        spinitronId: '99999',
        spinitronUrl: 'https://spinitron.com/WOWD/pl/99999/My-Tiny-Morning-Show',
      },
    ], 1);
    await srv.store.saveEpisodeTracks('ep-one', {
      ...SAMPLE_TRACKS,
      spinitronUrl: 'https://spinitron.com/WOWD/pl/12345/My-Tiny-Morning-Show',
    }, 1);

    outboundCalls = [];
    globalThis.fetch = async (url, init) => {
      const s = String(url);
      if (!s.startsWith(srv.baseUrl)) {
        outboundCalls.push(s);
        throw new Error(`Unexpected outbound fetch: ${s}`);
      }
      return originalFetch(url, init);
    };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await srv.close();
  });

  it('serves episodes, tracks, spinitron lookup, and SSR metadata strictly from the DB', async () => {
    const epRes = await fetch(`${srv.baseUrl}/api/episodes`);
    assert.equal(epRes.status, 200);
    const epBody = await epRes.json();
    assert.equal(epBody.episodes.length, 2);
    assert.equal(epBody.episodes[0].slug, 'ep-one');

    const refreshRes = await fetch(`${srv.baseUrl}/api/episodes?refresh=1`);
    assert.equal(refreshRes.status, 200);
    assert.equal((await refreshRes.json()).episodes.length, 2);

    const tracksRes = await fetch(`${srv.baseUrl}/api/episodes/ep-one/tracks?spinitronId=12345`);
    assert.equal(tracksRes.status, 200);
    const tracksBody = await tracksRes.json();
    assert.equal(tracksBody.source, 'mixcloud+spinitron');
    assert.equal(tracksBody.tracks.length, 3);
    assert.equal(tracksBody.fetchedAt, undefined);

    const emptyRes = await fetch(`${srv.baseUrl}/api/episodes/ep-no-tracks/tracks?spinitronId=99999`);
    assert.equal(emptyRes.status, 200);
    const emptyBody = await emptyRes.json();
    assert.deepEqual(emptyBody, {
      source: 'db',
      slug: 'ep-no-tracks',
      spinitronId: '99999',
      spinitronUrl: 'https://spinitron.com/WOWD/pl/99999/My-Tiny-Morning-Show',
      description: '',
      tracks: [],
    });

    const spinRes = await fetch(`${srv.baseUrl}/api/tracks/12345`);
    assert.equal(spinRes.status, 200);
    const spinBody = await spinRes.json();
    assert.equal(spinBody.playlistId, '12345');
    assert.equal(spinBody.tracks.length, 3);

    const missingSpinRes = await fetch(`${srv.baseUrl}/api/tracks/77777`);
    assert.equal(missingSpinRes.status, 404);

    const ssrRes = await fetch(`${srv.baseUrl}/?ep=ep-one&track=2`);
    assert.equal(ssrRes.status, 200);
    const ssrHtml = await ssrRes.text();
    assert.match(ssrHtml, /property="og:title" content="Second &amp; Band — Sun &quot;Rise&quot;"/);

    assert.deepEqual(outboundCalls, []);
  });
});

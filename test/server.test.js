import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, pickPreviewImage, getCanonicalOrigin } from '../server.js';

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
  const server = createServer(overrides);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
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
  let lastRefreshArg;
  let lastTracksArgs;
  let lastTracklistArg;

  before(async () => {
    srv = await startTestServer({
      getEpisodes: async (refresh) => {
        lastRefreshArg = refresh;
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

  it('serves /api/episodes and passes refresh flag', async () => {
    const r1 = await fetch(`${srv.baseUrl}/api/episodes`);
    assert.equal(r1.status, 200);
    assert.equal(lastRefreshArg, false);
    const body1 = await r1.json();
    assert.equal(body1.episodes.length, 1);

    const r2 = await fetch(`${srv.baseUrl}/api/episodes?refresh=1`);
    assert.equal(r2.status, 200);
    assert.equal(lastRefreshArg, true);
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

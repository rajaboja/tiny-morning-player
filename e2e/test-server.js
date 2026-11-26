import { createServer } from '../server.js';
import { createStore } from '../lib/db.js';

const PORT = Number(process.env.PORT) || 3100;
const PLACEHOLDER_IMG = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%23334155"/></svg>';

const EPISODES = [
  {
    mixcloudKey: '/bob-boilen/ep-morning-1/',
    mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-morning-1/',
    name: 'My Tiny Morning Show - Jan 10, 2026',
    slug: 'ep-morning-1',
    date: '2026-01-10',
    audioLength: 7200,
    picture: PLACEHOLDER_IMG,
    spinitronId: '1001',
    spinitronUrl: 'https://spinitron.com/WOWD/pl/1001/My-Tiny-Morning-Show',
  },
  {
    mixcloudKey: '/bob-boilen/ep-morning-2/',
    mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-morning-2/',
    name: 'My Tiny Morning Show - Jan 03, 2026',
    slug: 'ep-morning-2',
    date: '2026-01-03',
    audioLength: 3600,
    picture: PLACEHOLDER_IMG,
    spinitronId: '1002',
    spinitronUrl: 'https://spinitron.com/WOWD/pl/1002/My-Tiny-Morning-Show',
  },
  {
    mixcloudKey: '/bob-boilen/ep-no-tracks/',
    mixcloudUrl: 'https://www.mixcloud.com/bob-boilen/ep-no-tracks/',
    name: 'My Tiny Morning Show - Dec 27, 2025',
    slug: 'ep-no-tracks',
    date: '2025-12-27',
    audioLength: 5400,
    picture: PLACEHOLDER_IMG,
    spinitronId: null,
    spinitronUrl: null,
  },
];

const TRACKS_BY_SLUG = {
  'ep-morning-1': {
    source: 'mixcloud+spinitron',
    slug: 'ep-morning-1',
    spinitronId: '1001',
    description: 'Fresh morning tunes for Saturday.',
    tracks: [
      {
        artist: 'Miles Davis',
        song: 'Blue in Green',
        album: 'Kind of Blue',
        time: '8:00 AM',
        offsetSeconds: 0,
        artwork: null,
      },
      {
        artist: 'Khruangbin',
        song: 'Time (You and I)',
        album: 'Mordechai',
        time: '8:02 AM',
        offsetSeconds: 120,
        artwork: null,
      },
      {
        artist: 'Nina Simone',
        song: 'Feeling Good',
        album: 'I Put a Spell on You',
        time: '8:05 AM',
        offsetSeconds: 300,
        artwork: null,
      },
    ],
  },
  'ep-morning-2': {
    source: 'mixcloud+spinitron',
    slug: 'ep-morning-2',
    spinitronId: '1002',
    description: 'New Year weekend edition.',
    tracks: [
      {
        artist: 'Bill Evans',
        song: 'Peace Piece',
        album: 'Everybody Digs Bill Evans',
        time: '8:00 AM',
        offsetSeconds: 0,
        artwork: null,
      },
      {
        artist: 'Stereolab',
        song: 'French Disko',
        album: 'Switched On',
        time: '8:04 AM',
        offsetSeconds: 240,
        artwork: null,
      },
    ],
  },
  'ep-no-tracks': {
    source: 'spinitron',
    slug: 'ep-no-tracks',
    spinitronId: null,
    description: 'Archive episode without tracklist.',
    tracks: [],
  },
};

const store = createStore({ url: ':memory:' });

const server = createServer({
  store,
  getEpisodes: async () => EPISODES,
  getEpisodeTracks: async (slug) => TRACKS_BY_SLUG[slug] || { source: 'spinitron', slug, description: '', tracks: [] },
  getTracklist: async (id) => ({ playlistId: id, tracks: [] }),
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`E2E fixture server listening on http://127.0.0.1:${PORT}`);
});

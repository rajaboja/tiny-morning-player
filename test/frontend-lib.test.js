import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  escapeHtml,
  formatEpisodeLength,
  formatTrackLabel,
  parseDeepLink,
  buildTrackUrl,
  resolveTrackIndexByTime,
  filterTracks,
} from '../public/lib.js';

describe('frontend pure helpers (public/lib.js)', () => {
  it('formats durations in m:ss and h:mm:ss', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(-12), '0:00');
    assert.equal(formatDuration(65.9), '1:05');
    assert.equal(formatDuration(3665), '1:01:05');
  });

  it('formats episode lengths', () => {
    assert.equal(formatEpisodeLength(0), '');
    assert.equal(formatEpisodeLength(2700), '45m');
    assert.equal(formatEpisodeLength(7200), '2h 00m');
    assert.equal(formatEpisodeLength(5460), '1h 31m');
  });

  it('formats track labels and escapes HTML', () => {
    assert.equal(formatTrackLabel({ artist: 'Miles', song: 'So What' }), 'Miles — So What');
    assert.equal(formatTrackLabel({ artist: '', song: 'Instrumental' }), 'Instrumental');
    assert.equal(formatTrackLabel({ artist: 'Solo', song: '' }), 'Solo');
    assert.equal(formatTrackLabel({}), 'Track');
    assert.equal(escapeHtml('<script>"&"</script>'), '&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;');
  });

  it('parses deep link query params', () => {
    assert.deepEqual(parseDeepLink('?ep=my-show&track=3'), {
      ep: 'my-show',
      trackIndex: 2,
      seconds: null,
    });
    assert.deepEqual(parseDeepLink('?ep= my-show &t=245'), {
      ep: 'my-show',
      trackIndex: null,
      seconds: 245,
    });
    assert.deepEqual(parseDeepLink('?ep=my-show&track=0&t=abc'), {
      ep: 'my-show',
      trackIndex: null,
      seconds: null,
    });
    assert.deepEqual(parseDeepLink(''), {
      ep: null,
      trackIndex: null,
      seconds: null,
    });
  });

  it('builds canonical episode and track share URLs', () => {
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1'), 'https://player.example.com/?ep=ep-1');
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1', 0), 'https://player.example.com/?ep=ep-1&track=1');
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1', 4), 'https://player.example.com/?ep=ep-1&track=5');
  });

  it('resolves active track index from playback time and sync offset', () => {
    const tracks = [
      { offsetSeconds: 0 },
      { offsetSeconds: 120 },
      { offsetSeconds: 300 },
    ];
    assert.equal(resolveTrackIndexByTime([], 50), null);
    assert.equal(resolveTrackIndexByTime(tracks, 0), 0);
    assert.equal(resolveTrackIndexByTime(tracks, 119), 0);
    assert.equal(resolveTrackIndexByTime(tracks, 120), 1);
    assert.equal(resolveTrackIndexByTime(tracks, 500), 2);
    assert.equal(resolveTrackIndexByTime(tracks, 115, -10), 1);
    assert.equal(resolveTrackIndexByTime(tracks, 125, 10), 0);
  });

  it('filters tracks across song, artist, and album while preserving original index', () => {
    const tracks = [
      { song: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue' },
      { song: 'Red Clay', artist: 'Freddie Hubbard', album: 'CTI Sessions' },
      { song: 'Green Onions', artist: 'Booker T.', album: '' },
    ];
    assert.equal(filterTracks(tracks, '').length, 3);
    const bySong = filterTracks(tracks, 'green');
    assert.deepEqual(bySong.map((t) => t._idx), [0, 2]);
    const byArtist = filterTracks(tracks, 'HUBBARD');
    assert.deepEqual(byArtist.map((t) => t._idx), [1]);
    const byAlbum = filterTracks(tracks, 'kind of blue');
    assert.deepEqual(byAlbum.map((t) => t._idx), [0]);
  });
});

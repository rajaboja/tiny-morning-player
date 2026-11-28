import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  clampSeekTarget,
  evaluateSeekAttempt,
  evaluateSeekProgress,
  SEEK_MAX_ATTEMPTS,
  SEEK_WINDOW_MS,
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
      list: null,
      trackIndex: 2,
      seconds: null,
    });
    assert.deepEqual(parseDeepLink('?ep= my-show &t=245'), {
      ep: 'my-show',
      list: null,
      trackIndex: null,
      seconds: 245,
    });
    assert.deepEqual(parseDeepLink('?list=abc123'), {
      ep: null,
      list: 'abc123',
      trackIndex: null,
      seconds: null,
    });
    assert.deepEqual(parseDeepLink('?ep=my-show&track=0&t=abc'), {
      ep: 'my-show',
      list: null,
      trackIndex: null,
      seconds: null,
    });
    assert.deepEqual(parseDeepLink(''), {
      ep: null,
      list: null,
      trackIndex: null,
      seconds: null,
    });
  });

  it('builds canonical episode, track, and list share URLs and track keys', () => {
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1'), 'https://player.example.com/?ep=ep-1');
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1', 0), 'https://player.example.com/?ep=ep-1&track=1');
    assert.equal(buildTrackUrl('https://player.example.com', 'ep-1', 4), 'https://player.example.com/?ep=ep-1&track=5');
    assert.equal(buildListUrl('https://player.example.com', 'xyz99'), 'https://player.example.com/?list=xyz99');
    assert.equal(makeTrackKey('ep-1', 2), 'ep-1:2');
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

  it('ignores synthetic dur=0 ticks, re-seeks after cold-start reset, and confirms once advancing near target', () => {
    const key = '/bob-boilen/ep-1/';
    let pending = createPendingSeek(key, 600);
    assert.equal(pending.target, 600);
    assert.equal(pending.startedAt, null);

    // Initial seek attempt
    let attempt = evaluateSeekAttempt(pending, key, 1000);
    assert.equal(attempt.action, 'seek');
    assert.equal(attempt.target, 600);
    pending = attempt.nextPending;

    // Mixcloud emits synthetic progress(600, 0) before audio loads: must be ignored
    let res = evaluateSeekProgress(pending, key, 600, 0, 1050);
    assert.equal(res.action, 'ignore');
    assert.equal(res.ignorePosition, true);
    assert.equal(res.nextPending, pending);

    // Audio loads 3s later and resets position to 0 with real duration: must re-seek and suppress UI flicker
    res = evaluateSeekProgress(pending, key, 0, 7050, 4050);
    assert.equal(res.action, 'seek');
    assert.equal(res.seekTarget, 600);
    assert.equal(res.ignorePosition, true);
    pending = res.nextPending;

    // Play event arriving 15ms later is debounced by cooldown
    attempt = evaluateSeekAttempt(pending, key, 4065, 7050);
    assert.equal(attempt.action, 'wait');
    pending = attempt.nextPending;

    // Optimistic tick at 600 does not immediately clear pendingSeek
    res = evaluateSeekProgress(pending, key, 600, 7050, 4100);
    assert.equal(res.action, 'wait');
    assert.notEqual(res.nextPending, null);
    pending = res.nextPending;

    // Transient reset to 0 within cooldown resets nearTarget tracking without spamming seek
    res = evaluateSeekProgress(pending, key, 0, 7050, 4600);
    assert.equal(res.action, 'wait');
    assert.equal(res.ignorePosition, true);
    assert.equal(res.nextPending.nearTargetPos, null);
    pending = res.nextPending;

    // Seek settles at 600, then advances to 601: confirmed and cleared
    res = evaluateSeekProgress(pending, key, 600, 7050, 4650);
    assert.equal(res.action, 'wait');
    pending = res.nextPending;

    res = evaluateSeekProgress(pending, key, 601, 7050, 5650);
    assert.equal(res.action, 'confirmed');
    assert.equal(res.nextPending, null);
    assert.equal(res.ignorePosition, false);
  });

  it('clamps seek target to audio duration and stops retrying after max attempts or window expiry', () => {
    const key = '/bob-boilen/ep-1/';
    assert.equal(createPendingSeek(key, 0), null);
    assert.equal(clampSeekTarget(7200, 7050), 7048);

    // Passive shared-link pendingSeek starts its window only when playback starts
    let pending = createPendingSeek(key, 7200);
    let res = evaluateSeekProgress(pending, key, 0, 7050, 999999);
    assert.equal(res.action, 'seek');
    assert.equal(res.seekTarget, 7048);
    pending = res.nextPending;

    // Window expiry clears pendingSeek so manual playback is never hijacked forever
    res = evaluateSeekProgress(pending, key, 10, 7050, 999999 + SEEK_WINDOW_MS + 1);
    assert.equal(res.action, 'clear');
    assert.equal(res.nextPending, null);

    // Max attempts cap clears pendingSeek
    pending = createPendingSeek(key, 300);
    let t = 1000;
    for (let i = 0; i < SEEK_MAX_ATTEMPTS; i++) {
      const attempt = evaluateSeekAttempt(pending, key, t, 3600);
      assert.equal(attempt.action, 'seek');
      pending = attempt.nextPending;
      t += 1000;
    }
    const capped = evaluateSeekAttempt(pending, key, t, 3600);
    assert.equal(capped.action, 'clear');
    assert.equal(capped.nextPending, null);
  });
});

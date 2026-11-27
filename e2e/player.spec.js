import { test, expect } from '@playwright/test';

const MIXCLOUD_STUB_JS = `
  window.__mixcloudMock = {
    loads: [],
    plays: 0,
    seeks: [],
    progressHandlers: [],
    playHandlers: [],
    emitProgress(pos, dur) {
      for (const fn of this.progressHandlers) fn(pos, dur);
    },
    emitPlay() {
      for (const fn of this.playHandlers) fn();
    },
  };
  window.Mixcloud = {
    PlayerWidget() {
      return {
        ready: Promise.resolve(),
        load(key, autoplay) {
          window.__mixcloudMock.loads.push({ key, autoplay });
          return Promise.resolve();
        },
        play() {
          window.__mixcloudMock.plays += 1;
          return Promise.resolve();
        },
        seek(seconds) {
          window.__mixcloudMock.seeks.push(seconds);
          return Promise.resolve();
        },
        events: {
          play: {
            on(fn) {
              window.__mixcloudMock.playHandlers.push(fn);
            },
          },
          progress: {
            on(fn) {
              window.__mixcloudMock.progressHandlers.push(fn);
            },
          },
        },
      };
    },
  };
`;

test.beforeEach(async ({ page }) => {
  await page.route('https://widget.mixcloud.com/media/js/widgetApi.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: MIXCLOUD_STUB_JS,
    }),
  );
  await page.route('https://player-widget.mixcloud.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>mock player</body></html>',
    }),
  );
});

test('loads episodes, switches episodes, and handles empty tracklists', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#episode-count')).toHaveText('3');
  await expect(page.locator('#ep-title')).toHaveText('My Tiny Morning Show - Jan 10, 2026');
  await expect(page.locator('.track-row')).toHaveCount(3);

  await page.locator('.episode-item', { hasText: 'Jan 03, 2026' }).click();
  await expect(page.locator('#ep-title')).toHaveText('My Tiny Morning Show - Jan 03, 2026');
  await expect(page.locator('.track-row')).toHaveCount(2);
  await expect(page).toHaveURL(/\/\?ep=ep-morning-2$/);

  await page.locator('.episode-item', { hasText: 'Dec 27, 2025' }).click();
  await expect(page.locator('#play-full-ep')).toBeVisible();
  await page.locator('#play-full-ep').click();
  const mock = await page.evaluate(() => ({
    plays: window.__mixcloudMock.plays,
    loads: window.__mixcloudMock.loads,
  }));
  expect(mock.plays).toBeGreaterThanOrEqual(1);
  expect(mock.loads.at(-1)).toEqual({ key: '/bob-boilen/ep-no-tracks/', autoplay: true });
});

test('filters tracks by song, artist, and album', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.track-row')).toHaveCount(3);

  await page.locator('#track-search').fill('khruangbin');
  await expect(page.locator('.track-row')).toHaveCount(1);
  await expect(page.locator('.track-song')).toHaveText('Time (You and I)');

  await page.locator('#track-search').fill('spell on you');
  await expect(page.locator('.track-row')).toHaveCount(1);
  await expect(page.locator('.track-artist')).toHaveText('Nina Simone');

  await page.locator('#track-search').fill('no-such-track');
  await expect(page.locator('.track-row')).toHaveCount(0);
  await expect(page.locator('#tracklist-container')).toContainText('No matching tracks.');
});

test('plays clicked track, applies sync nudges, and tracks Mixcloud progress', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.track-row')).toHaveCount(3);

  await page.locator('.sync-control button[data-nudge="10"]').click();
  await expect(page.locator('#sync-value')).toHaveText('+10s');

  await page.locator('.track-row').nth(1).click();
  await expect(page).toHaveURL(/\/\?ep=ep-morning-1&track=2$/);
  await expect(page).toHaveTitle('Khruangbin — Time (You and I) · My Tiny Morning Show');
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/playing/);
  await expect(page.locator('#player-status')).toContainText('2:10');

  const seeks = await page.evaluate(() => window.__mixcloudMock.seeks);
  expect(seeks).toContain(130);

  await page.evaluate(() => window.__mixcloudMock.emitProgress(320));
  await expect(page.locator('.track-row').nth(2)).toHaveClass(/playing/);
  await expect(page.locator('.track-row').nth(1)).not.toHaveClass(/playing/);
});

test('supports track and timestamp deep links and unknown episode fallback', async ({ page }) => {
  await page.goto('/?ep=ep-morning-1&track=2');
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/shared/);
  await expect(page.locator('#player-status')).toContainText('Shared track: Khruangbin — Time (You and I)');

  await page.locator('.status-play-btn').click();
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/playing/);

  await page.goto('/?ep=ep-morning-1&t=250');
  await expect(page).toHaveURL(/\/\?ep=ep-morning-1&track=2$/);
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/shared/);

  await page.goto('/?ep=does-not-exist');
  await expect(page.locator('#player-status')).toContainText('Shared episode not found; showing latest episode.');
  await expect(page.locator('#ep-title')).toHaveText('My Tiny Morning Show - Jan 10, 2026');
});

test('copies track share link and displays copied feedback', async ({ page }) => {
  await page.addInitScript(() => {
    window.__copiedText = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedText = text;
        },
      },
    });
  });

  await page.goto('/');
  await expect(page.locator('.track-row')).toHaveCount(3);

  const shareBtn = page.locator('.track-row').nth(2).locator('.share-btn');
  await shareBtn.click();

  await expect(shareBtn).toHaveClass(/copied/);
  const copied = await page.evaluate(() => window.__copiedText);
  expect(copied).toBe('http://127.0.0.1:3100/?ep=ep-morning-1&track=3');
});

test('opens and closes mobile episodes drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#episodes-toggle')).toBeVisible();

  await page.locator('#episodes-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await expect(page.locator('#episodes-toggle')).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('#episodes-toggle')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('#episodes-toggle').click();
  await page.locator('.episode-item', { hasText: 'Jan 03, 2026' }).click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
});

test('persists favorited tracks across reloads and plays from Favorites view', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.track-row')).toHaveCount(3);
  await expect(page.locator('#favorites-count')).toHaveText('0');

  const favBtn = page.locator('.track-row').nth(1).locator('.fav-btn');
  await favBtn.click();
  await expect(favBtn).toHaveClass(/favorited/);
  await expect(page.locator('#favorites-count')).toHaveText('1');

  await page.reload();
  await expect(page.locator('#favorites-count')).toHaveText('1');
  await expect(page.locator('.track-row').nth(1).locator('.fav-btn')).toHaveClass(/favorited/);

  await page.locator('.sidebar-tab[data-tab="favorites"]').click();
  await expect(page.locator('#collection-title')).toHaveText('Favorites');
  await expect(page.locator('.saved-track-row')).toHaveCount(1);
  await expect(page.locator('.saved-track-row .track-song')).toHaveText('Time (You and I)');

  await page.locator('.saved-track-row').first().click();
  await expect(page.locator('#player-status')).toContainText('Khruangbin — Time (You and I)');
  const seeks = await page.evaluate(() => window.__mixcloudMock.seeks);
  expect(seeks).toContain(120);

  await page.locator('.saved-track-row .fav-btn').first().click();
  await expect(page.locator('#favorites-count')).toHaveText('0');
  await expect(page.locator('#tracklist-container')).toContainText('No favorite tracks yet.');

  await page.reload();
  await expect(page.locator('#favorites-count')).toHaveText('0');
});

test('creates, persists, shares, renames, deep-links, and deletes custom lists', async ({ page }) => {
  await page.addInitScript(() => {
    window.__copiedText = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedText = text;
        },
      },
    });
  });

  await page.goto('/');
  await expect(page.locator('.track-row')).toHaveCount(3);

  // Add track 2 from episode 1 via modal and create a new list on the spot
  await page.locator('.track-row').nth(1).locator('.list-add-btn').click();
  await expect(page.locator('#list-modal')).toBeVisible();
  await page.locator('#modal-new-list-name').fill('Morning Coffee');
  await page.locator('#modal-create-list-form button[type="submit"]').click();
  await expect(page.locator('#list-modal-options .modal-list-row')).toHaveCount(1);
  await expect(page.locator('#list-modal-options .modal-list-row').first()).toHaveClass(/in-list/);
  await page.locator('#list-modal-close').click();
  await expect(page.locator('#list-modal')).toBeHidden();

  // Switch to episode 2 and add track 2 to the existing list
  await page.locator('.episode-item', { hasText: 'Jan 03, 2026' }).click();
  await expect(page.locator('.track-row')).toHaveCount(2);
  await page.locator('.track-row').nth(1).locator('.list-add-btn').click();
  await page.locator('#list-modal-options .modal-list-row', { hasText: 'Morning Coffee' }).click();
  await expect(page.locator('#list-modal-options .modal-list-row', { hasText: 'Morning Coffee' })).toHaveClass(/in-list/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#list-modal')).toBeHidden();

  // Reload to verify DB persistence
  await page.reload();
  await expect(page.locator('#lists-count')).toHaveText('1');

  await page.locator('.sidebar-tab[data-tab="lists"]').click();
  await expect(page.locator('.list-item', { hasText: 'Morning Coffee' })).toContainText('2');
  await page.locator('.list-item', { hasText: 'Morning Coffee' }).click();

  await expect(page.locator('#collection-title')).toHaveText('Morning Coffee');
  await expect(page.locator('.saved-track-row')).toHaveCount(2);
  await expect(page).toHaveURL(/\/\?list=[a-zA-Z0-9_-]+$/);

  // Share list URL
  await page.locator('#share-list-btn').click();
  const copiedListUrl = await page.evaluate(() => window.__copiedText);
  expect(copiedListUrl).toMatch(/^http:\/\/127\.0\.0\.1:3100\/\?list=[a-zA-Z0-9_-]+$/);

  // Play track from list
  await page.locator('.saved-track-row').nth(1).click();
  await expect(page.locator('#player-status')).toContainText('Stereolab — French Disko');
  const seeks = await page.evaluate(() => window.__mixcloudMock.seeks);
  expect(seeks).toContain(240);

  // Open shared list deep link directly
  await page.goto(copiedListUrl);
  await expect(page.locator('#collection-title')).toHaveText('Morning Coffee');
  await expect(page.locator('.saved-track-row')).toHaveCount(2);

  // Rename list
  await page.locator('#rename-list-btn').click();
  await page.locator('#rename-list-input').fill('Sunday Coffee');
  await page.locator('#rename-list-form button[type="submit"]').click();
  await expect(page.locator('#collection-title')).toHaveText('Sunday Coffee');

  // Remove one track from the list
  await page.locator('.saved-track-row').first().locator('.remove-item-btn').click();
  await expect(page.locator('.saved-track-row')).toHaveCount(1);

  // Unknown list deep link falls back gracefully
  await page.goto('/?list=does-not-exist');
  await expect(page.locator('#player-status')).toContainText('Shared list not found; showing latest episode.');

  // Open renamed list and delete it
  await page.locator('.sidebar-tab[data-tab="lists"]').click();
  await page.locator('.list-item', { hasText: 'Sunday Coffee' }).click();
  await page.locator('#delete-list-btn').click();
  await expect(page.locator('#lists-count')).toHaveText('0');
});

test('re-seeks to shared track timestamp after uninitialized Mixcloud cold-start reset', async ({ page }) => {
  await page.goto('/?ep=ep-morning-1&track=2');
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/shared/);

  await page.locator('.status-play-btn').click();
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/playing/);

  // Initial seek was sent
  let seeks = await page.evaluate(() => window.__mixcloudMock.seeks.slice());
  expect(seeks).toEqual([120]);

  // Mixcloud emits a synthetic progress(120, 0) while audio is not yet loaded
  await page.evaluate(() => window.__mixcloudMock.emitProgress(120, 0));

  // Wait past retry cooldown, then simulate audio loading and resetting to position 0
  await page.waitForTimeout(950);
  await page.evaluate(() => {
    window.__mixcloudMock.emitProgress(0, 7200);
    window.__mixcloudMock.emitPlay();
  });

  // App must re-seek to 120 and must not flicker active row back to track 1
  seeks = await page.evaluate(() => window.__mixcloudMock.seeks.slice());
  expect(seeks).toEqual([120, 120]);
  await expect(page.locator('.track-row').nth(1)).toHaveClass(/playing/);
  await expect(page.locator('.track-row').nth(0)).not.toHaveClass(/playing/);

  // Playback settles at 120 and advances to 121 -> pending seek confirmed and cleared
  await page.evaluate(() => {
    window.__mixcloudMock.emitProgress(120, 7200);
    window.__mixcloudMock.emitProgress(121, 7200);
  });

  // Subsequent manual scrub to 310 must not be overridden back to 120
  await page.evaluate(() => window.__mixcloudMock.emitProgress(310, 7200));
  await expect(page.locator('.track-row').nth(2)).toHaveClass(/playing/);
  seeks = await page.evaluate(() => window.__mixcloudMock.seeks.slice());
  expect(seeks).toEqual([120, 120]);
});

test('waits for widget.ready when clicking a shared track before Mixcloud initializes', async ({ page }) => {
  const DEFERRED_MIXCLOUD_STUB_JS = `
    window.__mixcloudMock = {
      loads: [],
      plays: 0,
      seeks: [],
      progressHandlers: [],
      playHandlers: [],
      resolveReady: null,
    };
    window.Mixcloud = {
      PlayerWidget() {
        let resolveReady;
        const widget = {
          ready: new Promise((resolve) => { resolveReady = resolve; }),
          events: {},
        };
        window.__mixcloudMock.resolveReady = () => {
          widget.load = (key, autoplay) => {
            window.__mixcloudMock.loads.push({ key, autoplay });
            return Promise.resolve();
          };
          widget.play = () => {
            window.__mixcloudMock.plays += 1;
            return Promise.resolve();
          };
          widget.seek = (seconds) => {
            window.__mixcloudMock.seeks.push(seconds);
            return Promise.resolve();
          };
          widget.events.play = {
            on(fn) { window.__mixcloudMock.playHandlers.push(fn); },
          };
          widget.events.progress = {
            on(fn) { window.__mixcloudMock.progressHandlers.push(fn); },
          };
          resolveReady(widget);
        };
        return widget;
      },
    };
  `;

  await page.route('https://widget.mixcloud.com/media/js/widgetApi.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: DEFERRED_MIXCLOUD_STUB_JS,
    }),
  );

  await page.goto('/?ep=ep-morning-1&track=3');
  await expect(page.locator('.status-play-btn')).toBeVisible();

  // Click Play BEFORE widget.ready has resolved (methods are still undefined)
  await page.locator('.status-play-btn').click();
  await expect(page.locator('#player-status')).toContainText('5:00');

  // Now finish Mixcloud iframe initialization
  await page.evaluate(() => window.__mixcloudMock.resolveReady());

  await expect.poll(async () => page.evaluate(() => ({
    plays: window.__mixcloudMock.plays,
    seeks: window.__mixcloudMock.seeks,
  }))).toEqual({ plays: 1, seeks: [300] });
  await expect(page.locator('#player-status')).not.toContainText('did not auto-seek');
});

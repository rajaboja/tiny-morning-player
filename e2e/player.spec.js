import { test, expect } from '@playwright/test';

const MIXCLOUD_STUB_JS = `
  window.__mixcloudMock = {
    loads: [],
    plays: 0,
    seeks: [],
    progressHandlers: [],
    emitProgress(pos) {
      for (const fn of this.progressHandlers) fn(pos);
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

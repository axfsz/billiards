import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createGameServer } from '../server.js';

async function launch(t) {
  try { return await chromium.launch({ headless: true }); }
  catch (error) { t.skip(`Playwright Chromium is unavailable: ${error.message}`); return null; }
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function createInvitedMatch(browser, base) {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'zh-CN' });
  const host = await hostContext.newPage();
  let guest = await guestContext.newPage();
  const hostErrors = collectErrors(host), guestErrors = collectErrors(guest);

  await host.goto(base, { waitUntil: 'networkidle' });
  await host.getByRole('button', { name: /邀请好友/ }).click();
  await host.locator('#homeNickname').fill('阿青');
  await host.locator('#homeSubmitBtn').click();
  await host.locator('#onlineModal.show').waitFor();
  await host.getByRole('heading', { name: '好友等待房' }).waitFor();
  assert.equal(await host.locator('.lobby-seat').count(), 2);
  await host.waitForFunction(() => { const image = document.querySelector('.invite-qr img'); return image?.complete && image.naturalWidth > 0; }, undefined, { timeout: 5_000 });
  assert.equal(await host.locator('.invite-qr img').evaluate((image) => image.complete && image.naturalWidth > 0), true);
  const invite = await host.locator('.invite-link-display').textContent();

  await guest.goto(invite, { waitUntil: 'networkidle' });
  await guest.locator('#inviteSummary:not([hidden])').waitFor();
  assert.match(await guest.locator('#inviteHeadline').textContent(), /阿青 · 中式八球/);
  assert.equal(await guest.locator('#homeInviteLabel').isHidden(), true);
  await guest.locator('#homeNickname').fill('小林');
  await guest.locator('#homeSubmitBtn').click();

  await Promise.all([
    host.locator('#gameShell[data-room-status="PLAYING"]').waitFor({ timeout: 8_000 }),
    guest.locator('#gameShell[data-room-status="PLAYING"]').waitFor({ timeout: 8_000 }),
  ]);
  await host.locator('#closeOnline').click();
  await host.waitForFunction(() => !document.getElementById('onlineModal').classList.contains('show'));

  return { hostContext, guestContext, host, get guest() { return guest; }, set guest(value) { guest = value; }, hostErrors, guestErrors };
}

test('mobile home, errors, onboarding, and English settings remain usable', { timeout: 30_000 }, async (t) => {
  const app = createGameServer({ persistence: false });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await launch(t);
  if (!browser) { await app.close(); return; }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = collectErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#homeView:not([hidden])').waitFor();
    assert.equal(await page.locator('.home-action').count(), 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await page.getByRole('button', { name: /加入房间/ }).click();
    await page.locator('#homeInviteValue').fill('bad-code');
    await page.locator('#homeSubmitBtn').click();
    await page.getByText('请输入有效的 8 位邀请码或邀请链接').waitFor();
    await page.locator('#homeBackBtn').click();
    await page.getByRole('button', { name: /快速开始/ }).click();
    await page.locator('#onboarding:not([hidden])').waitFor();

    await page.locator('#moreBtn').click();
    await page.locator('#settingsBtn').click();
    await page.locator('#languageSetting').selectOption('en');
    assert.equal(await page.locator('#onlineBtn').textContent(), 'Online match');
    assert.match(await page.locator('#matchInfoText').textContent(), /break|Target/);
    assert.match(await page.locator('.stats > .chip.sel').textContent(), /^Game/);
    await page.locator('#settingsRulesBtn').click();
    await page.getByRole('heading', { name: 'Chinese 8-ball rules' }).waitFor();
    await page.locator('#closeRules').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close(); await app.close();
  }
});

test('home and playable table fit the target desktop and mobile viewport matrix', { timeout: 45_000 }, async (t) => {
  const app = createGameServer({ persistence: false });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await launch(t);
  if (!browser) { await app.close(); return; }
  const viewports = [[1366,768],[1440,900],[1920,1080],[375,667],[390,844],[393,852],[430,932]];
  try {
    for (const [width, height] of viewports) {
      const mobile = width <= 430;
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, locale: 'zh-CN' });
      const page = await context.newPage();
      const errors = collectErrors(page);
      await page.goto(base, { waitUntil: 'networkidle' });
      const homeLayout = await page.evaluate(() => {
        const panel = document.querySelector('.home-panel').getBoundingClientRect();
        return { horizontalFit: document.documentElement.scrollWidth <= innerWidth, panelLeft: panel.left, panelRight: panel.right, viewport: innerWidth };
      });
      assert.equal(homeLayout.horizontalFit, true, `${width}x${height} home should not scroll horizontally`);
      assert.ok(homeLayout.panelLeft >= 0 && homeLayout.panelRight <= homeLayout.viewport + 1, `${width}x${height} home panel should fit`);
      await page.getByRole('button', { name: /快速开始/ }).click();
      await page.waitForTimeout(120);
      const gameLayout = await page.evaluate(() => {
        const canvas = document.getElementById('cv'), rect = canvas.getBoundingClientRect();
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 1600) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) colored++;
        const controls = document.getElementById('mobileControls').getBoundingClientRect();
        return { horizontalFit: document.documentElement.scrollWidth <= innerWidth, verticalFit: document.documentElement.scrollHeight <= innerHeight + 1, canvas: { width: rect.width, height: rect.height }, controlsBottom: controls.bottom, colored };
      });
      assert.equal(gameLayout.horizontalFit, true, `${width}x${height} game should not scroll horizontally`);
      assert.ok(gameLayout.canvas.width >= (mobile ? 300 : 700) && gameLayout.canvas.height >= (mobile ? 170 : 380), `${width}x${height} table should remain legible: ${JSON.stringify(gameLayout.canvas)}`);
      assert.ok(gameLayout.colored > 20, `${width}x${height} canvas should contain rendered pixels`);
      if (mobile) {
        assert.equal(gameLayout.verticalFit, true, `${width}x${height} active game should fit one viewport`);
        assert.ok(gameLayout.controlsBottom <= height + 1, `${width}x${height} controls should stay visible`);
      }
      assert.deepEqual(errors, [], `${width}x${height} should not log browser errors`);
      await context.close();
    }
  } finally { await browser.close(); await app.close(); }
});

test('two browser contexts join by link, synchronize a shot, pause, reconnect, and restart together', { timeout: 45_000 }, async (t) => {
  const app = createGameServer({ persistence: false, reconnectGraceMs: 8_000 });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await launch(t);
  if (!browser) { await app.close(); return; }
  let match;
  try {
    match = await createInvitedMatch(browser, base);
    const beforeVersion = Number(await match.host.locator('#gameShell').getAttribute('data-state-version'));
    const canvas = match.host.locator('#cv');
    const box = await canvas.boundingBox();
    assert.ok(box, 'host table should be visible');
    await match.host.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.5);
    await match.host.mouse.down();
    await match.host.waitForTimeout(240);
    await match.host.mouse.up();
    await Promise.all([
      match.host.waitForFunction((version) => Number(document.getElementById('gameShell').dataset.stateVersion) >= version + 2, beforeVersion, { timeout: 15_000 }),
      match.guest.waitForFunction((version) => Number(document.getElementById('gameShell').dataset.stateVersion) >= version + 2, beforeVersion, { timeout: 15_000 }),
    ]);
    assert.equal(await match.host.locator('#gameShell').getAttribute('data-turn'), await match.guest.locator('#gameShell').getAttribute('data-turn'));

    await match.guest.close();
    await match.host.locator('#networkOverlay.show').waitFor({ timeout: 5_000 });
    assert.equal(await match.host.locator('#networkTitle').textContent(), '对方暂时离线');
    match.guest = await match.guestContext.newPage();
    const reconnectErrors = collectErrors(match.guest);
    await match.guest.goto(base, { waitUntil: 'networkidle' });
    await match.guest.locator('#gameShell[data-room-status="PLAYING"]').waitFor({ timeout: 8_000 });
    await match.host.waitForFunction(() => !document.getElementById('networkOverlay').classList.contains('show'), undefined, { timeout: 8_000 });

    const oldRack = await match.host.locator('#gameShell').getAttribute('data-rack-id');
    await match.host.locator('#restart').click();
    await match.guest.getByRole('button', { name: '接受' }).waitFor({ timeout: 5_000 });
    await match.guest.getByRole('button', { name: '接受' }).click();
    await Promise.all([
      match.host.waitForFunction((rack) => document.getElementById('gameShell').dataset.rackId !== rack, oldRack, { timeout: 8_000 }),
      match.guest.waitForFunction((rack) => document.getElementById('gameShell').dataset.rackId !== rack, oldRack, { timeout: 8_000 }),
    ]);
    assert.equal(await match.host.locator('#gameShell').getAttribute('data-rack-id'), await match.guest.locator('#gameShell').getAttribute('data-rack-id'));
    assert.deepEqual(match.hostErrors, []);
    assert.deepEqual(match.guestErrors, []);
    assert.deepEqual(reconnectErrors, []);
  } finally {
    if (match) { await match.hostContext.close(); await match.guestContext.close(); }
    await browser.close(); await app.close();
  }
});

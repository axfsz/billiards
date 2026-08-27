import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createGameServer } from '../server.js';

const DESKTOP = { width: 1365, height: 768 };
const WINDOWED_DESKTOP = { width: 1365, height: 960 };
const TOUCH = { width: 390, height: 844 };

function localPoint(box, x, y) {
  return { x: box.x + box.width * x / 1100, y: box.y + box.height * y / 640 };
}

async function nativeClick(page, target, touch) {
  const locator = typeof target === 'string' ? page.locator(target) : target;
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, `${target} should have a visible hit target`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function startLocalGame(page, touch) {
  await page.locator('#quickStartBtn').waitFor({ state: 'visible' });
  await nativeClick(page, '#quickStartBtn', touch);
  await page.waitForFunction(() => document.getElementById('homeView').hidden);
}

async function returnFromOnlineRoom(browser, page, base, touch) {
  await nativeClick(page, '#onlineBtn', touch);
  await page.locator('#onlineModal.show').waitFor();
  await nativeClick(page, '#onlineContent .online-primary', touch);
  await page.waitForFunction(() => document.getElementById('onlineBtn').textContent.startsWith('在线 · '), undefined, { timeout: 5_000 });
  assert.equal(await page.locator('#leaveLocalBtn').isHidden(), true, 'local exit should not be offered during an online room');
  const inviteCode = await page.locator('.online-code').textContent();
  await nativeClick(page, '#closeOnline', touch);
  await page.waitForFunction(() => !document.getElementById('onlineModal').classList.contains('show'));
  const guest = await browser.newContext({ viewport: DESKTOP, locale: 'zh-CN' });
  const guestPage = await guest.newPage();
  try {
    await guestPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await startLocalGame(guestPage, false);
    await nativeClick(guestPage, '#onlineBtn', false);
    await guestPage.locator('#onlineModal.show').waitFor();
    await nativeClick(guestPage, '#joinCode', false);
    await guestPage.keyboard.type(inviteCode);
    const join = guestPage.getByRole('button', { name: '加入比赛' });
    await join.waitFor({ state: 'visible' });
    await nativeClick(guestPage, join, false);
    await page.waitForFunction(() => document.getElementById('matchInfoText').textContent.includes('· 在线'), undefined, { timeout: 5_000 });
    await nativeClick(page, '#onlineMiniBtn', touch);
    await page.locator('#onlineModal.show').waitFor();
    const leave = page.getByRole('button', { name: '退出在线对局' });
    await leave.waitFor({ state: 'visible' });
    await nativeClick(page, leave, touch);
    const confirmLeave = page.getByRole('button', { name: '确认退出在线对局' });
    await confirmLeave.waitFor({ state: 'visible' });
    await nativeClick(page, confirmLeave, touch);
  } finally {
    await guest.close();
  }
  await page.waitForFunction(() => document.getElementById('onlineBtn').textContent === '在线对局', undefined, { timeout: 5_000 });
  await startLocalGame(page, touch);
  await page.waitForTimeout(250); // Let a queued room-state WebSocket message arrive if one exists.
}

async function createPlacement(page, touch) {
  const canvas = page.locator('#cv');
  const box = await canvas.boundingBox();
  assert.ok(box, 'table should be visible');

  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + box.width * 0.95, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box.x + box.width * 0.05, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await nativeClick(page, '#shootBtn', true);
  } else {
    const aim = localPoint(box, 286.8, 120);
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.down();
    await page.waitForTimeout(350);
    await page.mouse.up();
  }

  // A straight rail-only break is an illegal break, awarding local ball in hand.
  await page.waitForFunction(() => {
    const button = document.getElementById('shootBtn');
    return document.body.classList.contains('placement-active') && button.textContent === '确认位置' && !button.disabled;
  }, undefined, { timeout: 15_000 });
}

async function installClickBreakpoints(page, base) {
  const cdp = await page.context().newCDPSession(page);
  const scripts = [];
  const states = [];
  let evaluationError;
  cdp.on('Debugger.scriptParsed', (script) => scripts.push(script));
  cdp.on('Debugger.paused', async ({ callFrames }) => {
    try {
      const result = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: callFrames[0].callFrameId,
        expression: '({ state, placement: placement && { valid: placement.valid, scope: placement.scope }, hasOnlineRoom: Boolean(online.room) })',
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      states.push(result.result.value);
    } catch (error) {
      evaluationError = error;
    } finally {
      await cdp.send('Debugger.resume');
    }
  });
  await cdp.send('Debugger.enable');

  return {
    async arm() {
      const script = scripts.find((item) => item.url === `${base}/`);
      assert.ok(script, 'the app inline script should be available to the debugger');
      const button = await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("shootBtn")' });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: button.result.objectId });
      const listener = listeners.find((item) => item.type === 'click' && item.scriptId === script.scriptId);
      assert.ok(listener, `shoot button should retain its app click listener: ${JSON.stringify(listeners.map((item) => ({ type: item.type, scriptId: item.scriptId })))}`);
      const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
      const sourceLine = (index) => scriptSource.slice(0, index).split('\n').length - 1;
      const listenerSource = scriptSource.indexOf('document.getElementById("shootBtn").addEventListener("click", () => {');
      const confirmationStart = scriptSource.indexOf('function confirmPlacement()');
      const confirmationStateChange = scriptSource.indexOf('state = "aim";', confirmationStart);
      const confirmationAfterStateChange = scriptSource.indexOf('if (coarsePointer)', confirmationStateChange);
      assert.notEqual(listenerSource, -1, 'could not locate the shoot listener source');
      assert.notEqual(confirmationAfterStateChange, -1, 'could not locate the placement state change source');
      await cdp.send('Debugger.setBreakpoint', {
        location: { scriptId: listener.scriptId, lineNumber: listener.lineNumber, columnNumber: listener.columnNumber },
      });
      await cdp.send('Debugger.setBreakpoint', {
        location: {
          scriptId: listener.scriptId,
          lineNumber: listener.lineNumber - sourceLine(listenerSource) + sourceLine(confirmationAfterStateChange),
          columnNumber: 0,
        },
      });
    },
    assertStates() {
      assert.ifError(evaluationError);
      assert.ok(states.some((value) => value?.state === 'placement' && value.placement?.valid && !value.hasOnlineRoom), `native click should enter its handler with valid local placement and no stale online room: ${JSON.stringify(states)}`);
      assert.ok(states.some((value) => value?.state === 'aim' && !value.hasOnlineRoom), `native click should leave local placement in aim state: ${JSON.stringify(states)}`);
    },
  };
}

async function exercisePlacement(browser, base, { viewport, touch, inspectClosure, cycleOnline, confirmViaDoubleClick = false }) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__placementClickProbe = { events: [], buttonClicks: [] };
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      document.addEventListener(type, (event) => {
        window.__placementClickProbe.events.push({
          type,
          target: event.target?.id || event.target?.tagName || '',
          pointerType: event.pointerType || '',
          trusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
        });
      }, true);
    }
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('shootBtn')?.addEventListener('click', (event) => {
        window.__placementClickProbe.buttonClicks.push({
          trusted: event.isTrusted,
          text: event.currentTarget.textContent,
          disabled: event.currentTarget.disabled,
        });
      });
    });
  });

  let debuggerProbe;
  if (inspectClosure) debuggerProbe = await installClickBreakpoints(page, base);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator('#shootBtn').waitFor({ state: 'attached' });
  await startLocalGame(page, touch);
  if (debuggerProbe) await debuggerProbe.arm();

  const localHud = await page.evaluate(() => ({
    onlineText: document.getElementById('onlineBtn').textContent,
    playerNames: [...document.querySelectorAll('.player strong')].map((element) => element.textContent),
  }));
  assert.equal(localHud.onlineText, '在线对局');
  assert.ok(localHud.playerNames.every((name) => !name.includes('你')));
  if (touch) {
    await nativeClick(page, '#moreBtn', true);
    await page.locator('#leaveLocalBtn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#leaveLocalBtn').evaluate((button) => getComputedStyle(button).minHeight), '44px');
    await nativeClick(page, '#moreBtn', true);
  }
  if (cycleOnline) {
    await returnFromOnlineRoom(browser, page, base, touch);
    const returnedHud = await page.evaluate(() => ({
      onlineText: document.getElementById('onlineBtn').textContent,
      playerNames: [...document.querySelectorAll('.player strong')].map((element) => element.textContent),
    }));
    assert.equal(returnedHud.onlineText, '在线对局');
    assert.ok(returnedHud.playerNames.every((name) => !name.includes('你')));
  }

  await createPlacement(page, touch);
  const before = await page.evaluate(() => {
    const button = document.getElementById('shootBtn');
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      activeElement: document.activeElement?.id || '',
      disabled: button.disabled,
      text: button.textContent,
      target: target?.id || '',
      targetTag: target?.tagName || '',
      targetClass: target?.className || '',
      targetPath: (() => { const path = []; for (let node = target; node && path.length < 5; node = node.parentElement) path.push(node.id || node.className || node.tagName); return path; })(),
      rect: { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: innerHeight, document: document.documentElement.scrollHeight },
      layout: ['.room', '#gameShell', '.stage', '#cv', '.hint'].map((selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { selector, top: box.top, bottom: box.bottom, height: box.height, display: getComputedStyle(document.querySelector(selector)).display }; }),
      display: style.display,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      decisionVisible: document.getElementById('decisionModal').classList.contains('show'),
      onlineVisible: document.getElementById('onlineModal').classList.contains('show'),
      rulesVisible: document.getElementById('rulesModal').classList.contains('show'),
      controlsDisplay: getComputedStyle(document.getElementById('mobileControls')).display,
      hud: document.getElementById('matchInfoText').textContent,
    };
  });
  assert.equal(before.activeElement, '');
  assert.equal(before.disabled, false);
  assert.equal(before.text, '确认位置');
  if (touch) {
    assert.equal(before.target, 'shootBtn', JSON.stringify(before));
    assert.equal(before.display, 'block');
    assert.equal(before.pointerEvents, 'auto');
    assert.equal(before.visibility, 'visible');
    assert.equal(before.controlsDisplay, 'grid');
  } else {
    assert.equal(before.controlsDisplay, 'none');
    assert.match(before.hud, /双击球桌确认位置/);
  }
  assert.equal(before.decisionVisible, false);
  assert.equal(before.onlineVisible, false);
  assert.equal(before.rulesVisible, false);
  if (!touch) {
    const layout = await page.evaluate(() => ({ viewport: innerHeight, document: document.documentElement.scrollHeight }));
    assert.ok(layout.document <= layout.viewport, `desktop placement controls must fit the viewport: ${JSON.stringify(layout)}`);
  }

  if (confirmViaDoubleClick) {
    const canvas = await page.locator('#cv').boundingBox();
    assert.ok(canvas, 'table should have a placement target');
    const placementPoint = localPoint(canvas, 286.8, 120);
    await page.mouse.click(placementPoint.x, placementPoint.y);
    assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('placement-active')), true, 'a single click must only move the cue ball');
    await page.mouse.dblclick(placementPoint.x, placementPoint.y);
  } else {
    await nativeClick(page, '#shootBtn', touch);
  }
  await page.waitForFunction(() => {
    const button = document.getElementById('shootBtn');
    return !document.body.classList.contains('placement-active') && button.textContent === '击球';
  }, undefined, { timeout: 2_000 });
  if (debuggerProbe) debuggerProbe.assertStates();

  const after = await page.evaluate(() => window.__placementClickProbe);
  if (confirmViaDoubleClick) {
    assert.ok(after.events.some((event) => event.type === 'dblclick' && event.target === 'cv' && event.trusted), 'native canvas double-click should reach the table');
  } else {
    assert.ok(after.events.some((event) => event.type === 'pointerdown' && event.target === 'shootBtn' && event.trusted && (!touch || event.pointerType === 'touch')), 'document pointerdown should receive the native button press without interception');
    assert.ok(after.events.some((event) => event.type === 'click' && event.target === 'shootBtn' && event.trusted), 'native button click should reach the document');
    assert.ok(after.events.filter((event) => event.target === 'shootBtn').every((event) => !event.defaultPrevented), 'no top-level listener should cancel the button input');
    assert.deepEqual(after.buttonClicks.at(-1), { trusted: true, text: '击球', disabled: false });
  }
  if (cycleOnline) {
    await nativeClick(page, '#leaveLocalBtn', touch);
    await page.locator('#decisionModal.show').waitFor();
    assert.equal(await page.locator('#decisionTitle').textContent(), '退出本地双人');
    const confirmExit = page.getByRole('button', { name: '确认退出本地双人' });
    await confirmExit.waitFor({ state: 'visible' });
    await nativeClick(page, confirmExit, touch);
    await page.waitForFunction(() => !document.getElementById('decisionModal').classList.contains('show'));
    const exitedHud = await page.evaluate(() => ({
      onlineText: document.getElementById('onlineBtn').textContent,
      turnText: document.getElementById('matchInfoText').textContent,
    }));
    assert.equal(exitedHud.onlineText, '在线对局');
    assert.match(exitedHud.turnText, /Player 1 开球/);
  }
  assert.deepEqual(pageErrors, []);
  await context.close();
}

test('desktop double-click and touch button confirmation exit local ball-in-hand placement', { timeout: 60_000 }, async (t) => {
  const app = createGameServer({ persistence: false });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    await app.close();
    t.skip(`Playwright Chromium is unavailable: ${error.message}`);
    return;
  }
  try {
    await exercisePlacement(browser, base, { viewport: DESKTOP, touch: false, inspectClosure: false, cycleOnline: true, confirmViaDoubleClick: true });
    await exercisePlacement(browser, base, { viewport: WINDOWED_DESKTOP, touch: false, inspectClosure: false, cycleOnline: false, confirmViaDoubleClick: true });
    await exercisePlacement(browser, base, { viewport: TOUCH, touch: true, inspectClosure: false, cycleOnline: false });
  } finally {
    await browser.close();
    await app.close();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { settingsBounds, panelBounds, promptBounds, centeredBounds } = require('../../src/main/window-layout');

const screen = { x: 0, y: 25, width: 1728, height: 1050 };

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

test('settings opens clear of the panel at the right edge', () => {
  const panel = { x: 1328, y: 25, width: 400, height: 1050 };
  const b = settingsBounds(panel, screen);
  assert.strictEqual(b.clear, true);
  assert.strictEqual(b.width, 880);
  assert.ok(!overlaps(b, panel));
  assert.ok(b.x >= screen.x);
});

test('settings moves to the other side when the panel is on the left', () => {
  const panel = { x: 0, y: 25, width: 400, height: 1050 };
  const b = settingsBounds(panel, screen);
  assert.strictEqual(b.clear, true);
  assert.ok(b.x >= panel.width);
  assert.ok(b.x + b.width <= screen.x + screen.width);
});

test('settings shrinks to fit a small screen, then reports it could not stay clear', () => {
  const small = { x: 0, y: 25, width: 1100, height: 700 };
  const fits = settingsBounds({ x: 700, y: 25, width: 400, height: 700 }, small);
  assert.strictEqual(fits.clear, true);
  assert.strictEqual(fits.width, 668);

  const tiny = { x: 0, y: 25, width: 1000, height: 500 };
  const cramped = settingsBounds({ x: 300, y: 25, width: 400, height: 500 }, tiny);
  assert.strictEqual(cramped.clear, false);
  assert.strictEqual(cramped.width, 640);
  assert.strictEqual(cramped.height, 480);
  assert.strictEqual(cramped.x, 180);
});

test('settings stays on a second screen with a negative origin', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const b = settingsBounds({ x: -400, y: 0, width: 400, height: 1080 }, left);
  assert.strictEqual(b.clear, true);
  assert.ok(b.x >= left.x && b.x + b.width <= -400);
});

test('the panel opens top right, clear of the screen edges', () => {
  const b = panelBounds(screen, null);
  assert.strictEqual(b.x + b.width, screen.x + screen.width - 12);
  assert.strictEqual(b.y, screen.y + 12);
  assert.ok(b.height <= screen.height);
});

test('a saved panel position is used only while it is still on a screen', () => {
  const saved = { x: 200, y: 100, width: 420, height: 600 };
  assert.deepStrictEqual(panelBounds(screen, saved), saved);
  const gone = { x: 3000, y: 100, width: 420, height: 600 };
  assert.notDeepStrictEqual(panelBounds(screen, gone), gone);
  const second = { x: 1728, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(panelBounds(screen, gone, [screen, second]), gone);
});

test('the call prompt sits in the top right corner of the screen it is given', () => {
  const b = promptBounds(screen);
  assert.strictEqual(b.x + b.width, screen.x + screen.width - 12);
  assert.strictEqual(b.y, screen.y + 12);
  assert.ok(b.width <= 360 && b.height <= 80);
});

test('settings centers when the panel is hidden', () => {
  const b = centeredBounds(screen);
  assert.strictEqual(b.x - screen.x, screen.x + screen.width - (b.x + b.width));
  assert.strictEqual(b.clear, true);
});

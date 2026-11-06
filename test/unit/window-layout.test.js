'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { panelBounds, wideBounds, panelFromWide, setupBounds, promptBounds, WIDE_MIN_WIDTH } = require('../../src/main/window-layout');

const screen = { x: 0, y: 25, width: 1728, height: 1050 };
const panel = { x: 1296, y: 37, width: 420, height: 720 };

function onScreen(b, area) {
  return b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
}

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

test('the wide window grows left from a panel on the right', () => {
  const b = wideBounds(panel, screen);
  assert.strictEqual(b.x + b.width, panel.x + panel.width);
  assert.strictEqual(b.y, panel.y);
  assert.ok(onScreen(b, screen));
});

test('the wide window grows right from a panel on the left', () => {
  const b = wideBounds({ ...panel, x: 20 }, screen);
  assert.strictEqual(b.x, 20);
  assert.ok(onScreen(b, screen));
});

test('the wide window keeps the size it was left at', () => {
  const b = wideBounds(panel, screen, { width: 900, height: 600 });
  assert.strictEqual(b.width, 900);
  assert.strictEqual(b.height, 600);
});

test('the wide window fits a small screen', () => {
  const small = { x: 0, y: 25, width: 700, height: 500 };
  const b = wideBounds({ x: 280, y: 37, width: 420, height: 440 }, small);
  assert.strictEqual(b.width, 700);
  assert.strictEqual(b.height, 500);
  assert.ok(onScreen(b, small));
  assert.ok(WIDE_MIN_WIDTH > 700, 'this test needs a screen below the usual minimum');
});

test('the wide window stays on a second screen with a negative origin', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const b = wideBounds({ x: -432, y: 12, width: 420, height: 720 }, left);
  assert.ok(onScreen(b, left));
});

test('the panel comes back to the same place', () => {
  assert.deepStrictEqual(panelFromWide(wideBounds(panel, screen), panel, screen), panel);
  const leftPanel = { ...panel, x: 20 };
  assert.deepStrictEqual(panelFromWide(wideBounds(leftPanel, screen), leftPanel, screen), leftPanel);
});

test('the panel follows a wide window that was moved, and stays on screen', () => {
  const wide = { x: 40, y: 900, width: 1040, height: 700 };
  const b = panelFromWide(wide, panel, screen);
  assert.strictEqual(b.x, 40);
  assert.strictEqual(b.width, panel.width);
  assert.ok(onScreen(b, screen));
});

test('setup is centered', () => {
  const b = setupBounds(screen);
  assert.strictEqual(b.x - screen.x, screen.x + screen.width - (b.x + b.width));
  assert.ok(onScreen(b, screen));
});

test('the call prompt sits in the top right corner of the screen it is given', () => {
  const b = promptBounds(screen);
  assert.strictEqual(b.x + b.width, screen.x + screen.width - 12);
  assert.strictEqual(b.y, screen.y + 12);
  assert.ok(b.width <= 360 && b.height <= 80);
});

test('the app has a Dock icon, and the panel can still float over full screen', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /dock\.hide\(\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts', 'build-mac-app.sh'), 'utf8'), /LSUIElement/);
  assert.match(main, /win = new BrowserWindow\(\{[\s\S]*?type: process\.platform === 'darwin' \? 'panel'/);
});

test('the app menu has no way to reload the page that runs the mic', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /Menu\.setApplicationMenu/);
  assert.doesNotMatch(main, /role: '(reload|forceReload|toggleDevTools|viewMenu|fileMenu)'/);
});

test('a macOS prompt never leaves the window behind other apps', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /calendar\.request\(\)\.then\(\(access\) => \{[\s\S]{0,120}bringBack\(\)/);
  assert.match(main, /askForMediaAccess\('microphone'\);\n\s+bringBack\(\)/);
  assert.match(main, /await testCallAudio\(\);\n\s+bringBack\(\)/);
  assert.match(main, /checkNotesAccess\(\)\.then\(bringBack\)/);
});

test('the wide window never starts out floating', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /let floating = null;/);
});

test('a window behind other apps does not stop the call prompt', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /win\.isVisible\(\) && \(shape === 'panel' \|\| win\.isFocused\(\)\)/);
});

test('the app is one window and the call prompt', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.strictEqual(main.match(/new BrowserWindow\(/g).length, 2);
  assert.match(main, /titleBarStyle: 'hiddenInset'/);
  assert.doesNotMatch(main, /frame: false,\n\s+fullscreenable: false,\n\s+acceptFirstMouse/);
});

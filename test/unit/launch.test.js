'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CONNECTOR_FLAG, refuseLaunch, dropTestEnv } = require('../../src/main/launch');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('a public build refuses anything that could run outside code', () => {
  for (const arg of [
    '--inspect=9229',
    '--inspect-brk',
    '--remote-debugging-port=9222',
    '-remote-debugging-port=9222', // Chromium reads one dash as a switch too
    '--renderer-cmd-prefix=/tmp/evil',
    '--gpu-launcher=/tmp/evil',
    '--no-sandbox',
    '--user-data-dir=/tmp/x',
  ]) {
    assert.strictEqual(refuseLaunch([arg]), true, arg);
  }
});

test('a public build still opens normally, and for Claude Code', () => {
  assert.strictEqual(refuseLaunch([]), false);
  assert.strictEqual(refuseLaunch([CONNECTOR_FLAG, '--data', '/Users/a/Library/Application Support/Quickaside']), false);
  assert.strictEqual(refuseLaunch(['-psn_0_12345']), false);
  assert.strictEqual(refuseLaunch(['-NSDocumentRevisionsDebugMode', 'YES']), false);
});

test('test variables are dropped, and nothing else', () => {
  const env = { QUICKASIDE_DETECTOR: '/tmp/evil', QUICKASIDE_USER_DATA: '/tmp/x', PATH: '/usr/bin', HOME: '/Users/a' };
  dropTestEnv(env);
  assert.deepStrictEqual(env, { PATH: '/usr/bin', HOME: '/Users/a' });
});

test('the check runs first, so no switch or variable is read before it', () => {
  assert.strictEqual(JSON.parse(read('package.json')).main, 'src/main/index.js');
  const text = read('src/main/index.js');
  assert.ok(text.indexOf('dropTestEnv(process.env)') < text.indexOf("require('./main')"));
  assert.ok(text.indexOf('refuseLaunch(args)') < text.indexOf("require('./main')"));
  assert.ok(text.indexOf('refuseLaunch(args)') < text.indexOf("require('../connector/server')"));
});

test('every build turns off the ways to run outside code in the signed binary', () => {
  const text = read('scripts/build-mac-app.sh');
  for (const fuse of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
    assert.match(text, new RegExp(`electron-fuses write .*${fuse}=off`), fuse);
  }
  assert.ok(text.indexOf('electron-fuses write') < text.indexOf('sign-mac-app.sh "$OUT"'), 'fuses change the framework, so they come before signing');
});

test('a release is marked before signing, and a test build is never packed', () => {
  const text = read('scripts/release-mac.sh');
  assert.ok(text.indexOf('p.release = true') < text.indexOf('Signing, innermost code first'));
  assert.ok(text.indexOf('Not packed') < text.indexOf('ditto -c -k'));
});

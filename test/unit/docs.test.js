'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const DOCS = ['README.md', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'NOTICE', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/idea.yml'];

test('the public docs use no em dashes', () => {
  for (const file of DOCS) assert.doesNotMatch(read(file), /—/, file);
});

test('SECURITY.md states the limit of a self-signed app', () => {
  const text = read('SECURITY.md');
  assert.match(text, /tampered copy keeps the app's permissions/i);
  assert.match(text, /Team ID/);
  assert.match(text, /Report a vulnerability/);
});

test('the changelog has an entry for the version in package.json', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm'));
});

test('licences ship with the app', () => {
  const text = read('scripts/build-mac-app.sh');
  assert.match(text, /cp LICENSE NOTICE node_modules\/electron\/dist\/LICENSES\.chromium\.html/);
  assert.match(text, /node_modules\/electron\/dist\/LICENSE "\$RES\/licenses\/LICENSE\.electron"/);
  assert.ok(text.indexOf('$RES/licenses') < text.indexOf('sign-mac-app.sh "$OUT"'), 'they must be in place before signing');
});

test('NOTICE names what ships, and carries the MIT terms', () => {
  const text = read('NOTICE');
  for (const name of ['Electron', 'Chromium', 'AudioTee', 'whisper.cpp', 'cpp-httplib', 'JSON for Modern C++', 'miniaudio', 'stb_vorbis', 'OpenAI']) {
    assert.ok(text.includes(name), name);
  }
  assert.match(text, /Permission is hereby granted, free of charge/);
});

test('blank issues stay on, because Report a problem opens one', () => {
  assert.match(read('.github/ISSUE_TEMPLATE/config.yml'), /^blank_issues_enabled: true$/m);
  assert.match(read('src/main/main.js'), /\/new\?body=/);
});

test('the README install line is the one in install.sh, and it states the plan up front', () => {
  const readme = read('README.md');
  const line = /curl -fsSL https:\/\/raw\.githubusercontent\.com\/\S+ \| bash/.exec(read('scripts/install.sh'))[0];
  assert.ok(readme.includes(line), line);
  assert.match(readme.slice(0, readme.indexOf('## Install')), /paid Claude plan/);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'panel.png')));
});

test('the privacy page says what leaves the Mac, and nothing contradicts the code', () => {
  const text = read('PRIVACY.md');
  for (const host of ['update.electronjs.org', 'Hugging Face', 'GitHub', 'Anthropic']) assert.ok(text.includes(host), host);
  const sources = ['src/main/models.js', 'src/main/updater.js'].map(read).join('\n');
  assert.deepStrictEqual([...new Set(sources.match(/https:\/\/[a-z.]+/g))].sort(), ['https://huggingface.co', 'https://update.electronjs.org']);
  assert.match(read('src/main/main.js'), /uploadToServer: false/);
});

test('the links in the issue forms match this repo', () => {
  const { bugs } = JSON.parse(read('package.json'));
  const repo = bugs.url.replace(/\/issues$/, '');
  assert.ok(read('.github/ISSUE_TEMPLATE/config.yml').includes(`${repo}/security/advisories/new`));
  assert.ok(read('.github/ISSUE_TEMPLATE/bug.yml').includes(`${repo}/blob/main/SECURITY.md`));
});

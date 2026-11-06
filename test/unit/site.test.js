'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { COPIES, markdownToHtml, privacyPage } = require('../../scripts/build-site');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const PAGES = ['site/index.html', 'site/privacy.html'];
const index = read('site/index.html');

test('the site is up to date with PRIVACY.md and the images', () => {
  assert.strictEqual(read('site/privacy.html'), privacyPage(read('PRIVACY.md')), 'run npm run site');
  for (const [from, to] of COPIES) {
    assert.ok(fs.readFileSync(path.join(ROOT, from)).equals(fs.readFileSync(path.join(ROOT, to))), `run npm run site: ${to}`);
  }
});

test('the privacy page keeps every kind of markdown PRIVACY.md uses', () => {
  const html = markdownToHtml('# T\n\n## H\n\nSome **bold**, `code` & [a link](CHANGELOG.md).\n\n- one\n- two\n\n1. first\n\n| A | B |\n| --- | --- |\n| c | d |');
  for (const part of ['<h1>T</h1>', '<h2>H</h2>', '<strong>bold</strong>', '<code>code</code>', '&amp;', '<li>two</li>', '<ol>', '<th>A</th>', '<td>d</td>']) {
    assert.ok(html.includes(part), part);
  }
  assert.match(html, /href="https:\/\/github\.com\/[^"]+\/blob\/main\/CHANGELOG\.md"/);
  assert.doesNotMatch(read('site/privacy.html'), /\*\*|\]\(|^\||^- /m);
});

test('the site keeps the promise in PRIVACY.md: nothing from other sites, no cookies, no forms', () => {
  assert.match(read('PRIVACY.md'), /no cookies, no analytics and no forms, and it loads nothing from other sites/);
  for (const file of PAGES) {
    const html = read(file);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/, file);
    assert.doesNotMatch(html, /<form|<iframe/i, file);
    const loaded = [...html.matchAll(/<(?:script|img)\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\brel="(?:stylesheet|icon|apple-touch-icon)"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1] || m[2]);
    assert.ok(loaded.length >= 3, file);
    for (const url of loaded) {
      assert.doesNotMatch(url, /^(https?:)?\/\//, url);
      assert.ok(fs.existsSync(path.join(ROOT, 'site', url)), url);
    }
  }
  assert.doesNotMatch(read('site/site.css'), /url\(|@import/);
  assert.doesNotMatch(read('site/site.js'), /fetch\(|XMLHttpRequest|sendBeacon|cookie|localStorage/);
});

test('the install lines are the real ones', () => {
  const text = index.replace(/<wbr>/g, '');
  const line = /curl -fsSL https:\/\/raw\.githubusercontent\.com\/\S+ \| bash/.exec(read('scripts/install.sh'))[0];
  assert.ok(text.includes(`<code>${line}</code>`), line);
  assert.ok(text.includes('<code>curl -fsSL https://claude.ai/install.sh | bash</code>'));
  assert.ok(read('README.md').includes('curl -fsSL https://claude.ai/install.sh | bash'));
});

test('links on the site point at this repo', () => {
  const repo = JSON.parse(read('package.json')).bugs.url.replace(/\/issues$/, '');
  for (const file of PAGES) {
    for (const [url] of read(file).matchAll(/https:\/\/github\.com\/[^"\s<)]+/g)) assert.ok(url.startsWith(repo), url);
  }
});

test('the first screen states what it needs, before anyone installs', () => {
  const first = index.slice(0, index.indexOf('<main'));
  assert.match(first, /paid Claude plan/);
  assert.match(first, /Apple Silicon/);
  assert.match(first, /made-up client/);
});

test('the site tells people to disclose, and never sells hiding', () => {
  assert.match(index, /Tell people you're transcribing/);
  assert.match(index, /some places require everyone's consent/);
  assert.doesNotMatch(index, /invisible|undetect|stealth|secret|discreet|without (them|anyone) knowing|no one (will )?knows?/i);
});

test('the site says it is not Anthropic, and uses no em dashes', () => {
  for (const file of PAGES) {
    assert.match(read(file), /not made or endorsed by Anthropic/, file);
    assert.doesNotMatch(read(file), /—/, file);
  }
  assert.doesNotMatch(read('site/site.js'), /—/);
});

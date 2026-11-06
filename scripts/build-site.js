'use strict';
// Writes site/privacy.html from PRIVACY.md and copies in the images, so each promise
// and picture has one source. Run `npm run site` after changing them. The results are
// committed, so any static host can serve site/ with no build step, and a test fails
// if they fall behind. The markdown here is only what PRIVACY.md uses.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bugs.url.replace(/\/issues$/, '');

const COPIES = [
  ['docs/panel.png', 'site/panel.png'],
  ['build/icon-small.svg', 'site/favicon.svg'],
  ['src/assets/icon.png', 'site/icon.png'],
];

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A link to a file in the repo has to leave the site.
const href = (url) => (/^https:/.test(url) ? url : `${REPO}/blob/main/${url}`);

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => `<a href="${href(url)}">${label}</a>`);
}

function table(lines) {
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim()));
  const row = (line, tag) => `<tr>${cells(line).map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
  const [head, , ...body] = lines;
  return `<div class="table"><table>\n<thead>${row(head, 'th')}</thead>\n<tbody>\n${body.map((line) => row(line, 'td')).join('\n')}\n</tbody>\n</table></div>`;
}

function list(tag, lines, marker) {
  return `<${tag}>\n${lines.map((line) => `<li>${inline(line.replace(marker, ''))}</li>`).join('\n')}\n</${tag}>`;
}

function block(text) {
  const lines = text.split('\n');
  if (text.startsWith('# ')) return `<h1>${inline(text.slice(2))}</h1>`;
  if (text.startsWith('## ')) return `<h2>${inline(text.slice(3))}</h2>`;
  if (text.startsWith('|')) return table(lines);
  if (text.startsWith('- ')) return list('ul', lines, /^- /);
  if (/^\d+\. /.test(text)) return list('ol', lines, /^\d+\. /);
  return `<p>${inline(text)}</p>`;
}

function markdownToHtml(markdown) {
  return markdown.trim().split(/\n{2,}/).map(block).join('\n');
}

function privacyPage(markdown) {
  return `<!doctype html>
<!-- Made from PRIVACY.md by scripts/build-site.js. Change that file, not this one. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'">
  <title>Privacy: Quickaside</title>
  <meta name="description" content="What Quickaside keeps on your Mac, what leaves it, and how to delete it all.">
  <meta name="theme-color" content="#ffd60a">
  <link rel="canonical" href="https://quickaside.vercel.app/privacy.html">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icon.png">
  <link rel="stylesheet" href="site.css">
</head>
<body>
  <header class="page-head">
    <nav class="wrap nav" aria-label="Main">
      <a class="brand" href="./">
        <svg class="mark" viewBox="240 240 560 544" aria-hidden="true"><circle cx="429" cy="512" r="168"/><path d="M642.5 283.1A313 313 0 0 1 642.5 740.9"/></svg>
        Quickaside
      </a>
      <div class="nav-links">
        <a href="./#install">Install</a>
        <a href="${REPO}">GitHub</a>
      </div>
    </nav>
  </header>

  <main class="wrap doc">
${markdownToHtml(markdown)}
  </main>

  <footer class="foot">
    <div class="wrap">
      <p>Quickaside is an independent project under the MIT licence. It is not made or endorsed by Anthropic, and it runs Claude Code under your own account. Claude is a trademark of Anthropic.</p>
    </div>
  </footer>
</body>
</html>
`;
}

function build() {
  fs.writeFileSync(path.join(ROOT, 'site/privacy.html'), privacyPage(fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8')));
  for (const [from, to] of COPIES) fs.copyFileSync(path.join(ROOT, from), path.join(ROOT, to));
}

if (require.main === module) build();

module.exports = { COPIES, markdownToHtml, privacyPage };

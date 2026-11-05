'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { MAX_FILE_CHARS, MAX_CONTEXT_CHARS } = require('./prompts');

// Builds the overview on the Knowledge page. Reads run in child processes: a
// read stuck on a macOS prompt inside the main process stops the app quitting.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50000;

function runLines(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let partial = false;
    const timer = setTimeout(() => {
      partial = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ lines: [], partial: true });
    });
    p.on('close', () => {
      clearTimeout(timer);
      resolve({ lines: out.split('\n').filter(Boolean), partial });
    });
  });
}

// entries: { mtimeMs, size, file }, with file relative to the folder.
function summarizeEntries(entries, now = Date.now()) {
  const types = new Map();
  const top = new Map();
  const folders = new Set();
  let recent = 0;
  let latest = null;
  for (const e of entries) {
    const ext = path.extname(e.file).slice(1).toLowerCase() || 'other';
    types.set(ext, (types.get(ext) || 0) + 1);
    const parts = e.file.split('/');
    const group = parts.length > 1 ? parts[0] : 'Top level';
    top.set(group, (top.get(group) || 0) + 1);
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    if (now - e.mtimeMs < WEEK_MS) recent++;
    if (!latest || e.mtimeMs > latest.mtimeMs) latest = e;
  }
  const ranked = (map, limit) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  return {
    files: entries.length,
    folders: folders.size,
    recent,
    latest: latest ? { name: path.basename(latest.file), mtimeMs: latest.mtimeMs } : null,
    types: ranked(types, 5),
    top: ranked(top, 6),
  };
}

function parseStatLine(line, root) {
  const [mtime, size, ...rest] = line.split('\t');
  const full = rest.join('\t');
  if (!full.startsWith(root)) return null;
  return { mtimeMs: Number(mtime) * 1000, size: Number(size), file: full.slice(root.length).replace(/^\/+/, '') };
}

async function scanFolder(folder, { timeoutMs = 8000 } = {}) {
  const args = [folder, '(', '-name', '.*', '-o', '-name', 'node_modules', ')', '-prune', '-o', '-type', 'f', '-exec', '/usr/bin/stat', '-f', '%m\t%z\t%N', '{}', '+'];
  const root = folder.replace(/\/+$/, '');
  const { lines, partial } = await runLines('/usr/bin/find', args, { timeoutMs });
  const entries = lines
    .slice(0, MAX_ENTRIES)
    .map((l) => parseStatLine(l, root))
    .filter(Boolean);
  return { ...summarizeEntries(entries), partial: partial || lines.length > MAX_ENTRIES };
}

// Mirrors readContextFiles, from sizes alone, so the page can say what will be
// used without reading any file.
function budgetFor(stats) {
  let used = 0;
  let full = false;
  const files = stats.map(({ file, size }) => {
    const name = path.basename(file);
    if (size == null) return { file, name, state: 'missing', size: 0, used: 0 };
    const take = Math.min(size, MAX_FILE_CHARS);
    if (full || used + take > MAX_CONTEXT_CHARS) {
      full = true;
      return { file, name, state: 'left-out', size, used: 0 };
    }
    used += take;
    return { file, name, state: size > MAX_FILE_CHARS ? 'cut' : 'ok', size, used: take };
  });
  return { files, used, limit: MAX_CONTEXT_CHARS };
}

async function describeContextFiles(files, { timeoutMs = 4000 } = {}) {
  if (!files.length) return budgetFor([]);
  const { lines } = await runLines('/usr/bin/stat', ['-f', '%z\t%N', ...files], { timeoutMs });
  const sizes = new Map();
  for (const line of lines) {
    const [size, ...rest] = line.split('\t');
    sizes.set(rest.join('\t'), Number(size));
  }
  return budgetFor(files.map((file) => ({ file, size: sizes.has(file) ? sizes.get(file) : null })));
}

module.exports = { scanFolder, summarizeEntries, parseStatLine, budgetFor, describeContextFiles };

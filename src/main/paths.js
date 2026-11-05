'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Apps opened from Finder get a bare PATH (/usr/bin:/bin...). Claude Code and
// whisper usually live in ~/.local/bin or /opt/homebrew/bin, so we ask the
// user's login shell for its PATH once and add the usual install folders.

let shellPathPromise = null;

// True when child sits below parent. The folder itself does not count.
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function commonDirs() {
  const h = os.homedir();
  return [
    path.join(h, '.local', 'bin'),
    path.join(h, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(h, '.npm-global', 'bin'),
    path.join(h, '.bun', 'bin'),
    path.join(h, 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

function nvmDirs() {
  const base = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs
      .readdirSync(base)
      .sort()
      .reverse()
      .map((v) => path.join(base, v, 'bin'));
  } catch {
    return [];
  }
}

function loginShellPath() {
  if (shellPathPromise) return shellPathPromise;
  shellPathPromise = new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(process.env.PATH || '');
    const shell = process.env.SHELL || '/bin/zsh';
    const marker = '__CALLASIDE_PATH__';
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 6000, env: { ...process.env, TERM: 'dumb' } },
      (_err, stdout) => {
        const text = String(stdout || '');
        const start = text.indexOf(marker);
        const end = text.indexOf(marker, start + marker.length);
        if (start >= 0 && end > start) resolve(text.slice(start + marker.length, end));
        else resolve(process.env.PATH || '');
      }
    );
  });
  return shellPathPromise;
}

async function childEnv(extra = {}) {
  const shellPath = await loginShellPath();
  const parts = [
    ...shellPath.split(path.delimiter),
    ...(process.env.PATH || '').split(path.delimiter),
    ...commonDirs(),
    ...nvmDirs(),
  ].filter(Boolean);
  const env = { ...process.env, ...extra, PATH: [...new Set(parts)].join(path.delimiter) };
  // Child processes must not think they run inside Electron or another Claude Code session.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  return env;
}

async function findBinary(name, { explicit, candidates = [] } = {}) {
  const list = [];
  if (explicit) list.push(explicit);
  list.push(...candidates);
  const env = await childEnv();
  for (const dir of env.PATH.split(path.delimiter)) list.push(path.join(dir, name));
  for (const p of list) {
    if (p && isExecutable(p)) return p;
  }
  return null;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = { childEnv, findBinary, isExecutable, loginShellPath, expandHome, isInside };

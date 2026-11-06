'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code keeps what it learns as plain files on this Mac, one folder for each
// place it has been used. Claude chat memory lives in the user's account, and has
// no way in from here. This is only read when the user presses a button for it.

const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 100000;
const THROWAWAY = /^-(private-)?(tmp|var-folders)-/; // Claude Code run from a temp folder

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function plainFile(file) {
  const stat = await fs.promises.lstat(file).catch(() => null);
  return stat && stat.isFile() ? stat : null; // a link could point at a folder macOS guards, and a stuck read hangs the app
}

async function memoryFiles(dir) {
  const root = path.join(dir, 'projects');
  const folders = await fs.promises.readdir(root).catch(() => []);
  const found = [];
  for (const folder of folders) {
    if (THROWAWAY.test(folder)) continue;
    const memory = path.join(root, folder, 'memory');
    for (const name of await fs.promises.readdir(memory).catch(() => [])) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue; // that one is only an index of the others
      const file = path.join(memory, name);
      const stat = await plainFile(file);
      if (stat) found.push({ file, name: `${folder.replace(/^-Users-[^-]+-/, '')}/${name}`, mtimeMs: stat.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Newest first, so the budget goes on what is current.
async function readClaudeMemory({ dir = configDir() } = {}) {
  const files = await memoryFiles(dir);
  const own = path.join(dir, 'CLAUDE.md');
  if (await plainFile(own)) files.unshift({ file: own, name: 'CLAUDE.md' });
  const docs = [];
  let total = 0;
  for (const { file, name } of files) {
    const text = (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim().slice(0, MAX_FILE_CHARS);
    if (!text) continue;
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    docs.push({ name, text });
  }
  return docs;
}

module.exports = { readClaudeMemory };

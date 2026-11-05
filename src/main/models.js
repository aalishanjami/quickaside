'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Whisper models in whisper.cpp's ggml format, downloaded once from Hugging Face.
const MODELS = [
  {
    id: 'base.en',
    file: 'ggml-base.en.bin',
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    label: 'Fast',
    size: '148 MB',
    note: 'Lowest delay, more mistakes on names and accents.',
  },
  {
    id: 'small.en',
    file: 'ggml-small.en.bin',
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    label: 'Balanced',
    size: '488 MB',
    note: 'Good middle ground.',
  },
  {
    id: 'large-v3-turbo-q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    label: 'Accurate',
    size: '574 MB',
    note: 'Best with accents, names and technical terms. Needs Apple Silicon.',
  },
];

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

function getModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

function modelPath(dir, id) {
  const m = getModel(id);
  return m ? path.join(dir, m.file) : null;
}

function isDownloaded(dir, id) {
  const p = modelPath(dir, id);
  try {
    return !!p && fs.statSync(p).size > 20 * 1024 * 1024;
  } catch {
    return false;
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Keeps what it has if the connection drops, so a retry carries on from there.
async function downloadModel(dir, id, onProgress, signal, { baseUrl = BASE_URL, models = MODELS } = {}) {
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model ${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, m.file);
  const part = `${dest}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(baseUrl + m.file, { redirect: 'follow', signal, headers: have ? { Range: `bytes=${have}-` } : {} });
  // A file that was already complete, or a server that can't resume: start over.
  if (res.status === 416) {
    fs.unlinkSync(part);
    return downloadModel(dir, id, onProgress, signal, { baseUrl, models });
  }
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const resumed = res.status === 206;
  const start = resumed ? have : 0;
  const total = start + (Number(res.headers.get('content-length')) || 0);
  let received = start;
  let lastEmit = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 200) {
        lastEmit = now;
        onProgress({ id, received, total });
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  if (total && received < total) throw new Error('Download ended early. Try again.');
  if (m.sha256 && (await hashFile(part)) !== m.sha256) {
    fs.unlinkSync(part);
    throw new Error('The download was damaged. Try again.');
  }
  fs.renameSync(part, dest);
  if (onProgress) onProgress({ id, received, total: total || received, done: true });
  return dest;
}

module.exports = { MODELS, getModel, modelPath, isDownloaded, downloadModel };

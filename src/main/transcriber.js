'use strict';

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { encodeWav } = require('./audio/wav');

// Runs whisper.cpp on this Mac. Preferred: a long-running `whisper-server`
// that keeps the model loaded (built once by scripts/build-whisper.sh).
// Fallback: Homebrew's `whisper-cli`, started once per segment (slower).
//
// Events:
//   'line'   { source, startMs, endMs, speechMs, text }
//   'status' { state, mode, error, backlog }

class Transcriber extends EventEmitter {
  constructor({ resolveBinaries, getEnv }) {
    super();
    this.resolveBinaries = resolveBinaries;
    this.getEnv = getEnv;
    this.proc = null;
    this.queue = [];
    this.busy = false;
    this.status = { state: 'idle', mode: null, error: null, backlog: 0 };
    this.cfg = null;
    this.readyPromise = null;
    this.counter = 0;
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch, backlog: this.queue.length + (this.busy ? 1 : 0) };
    this.emit('status', this.status);
  }

  isRunning() {
    return this.status.state === 'ready' || this.status.state === 'starting';
  }

  // cfg: { modelPath, language, threads, prompt }
  start(cfg) {
    const key = JSON.stringify(cfg);
    if (this.readyPromise && this.cfgKey === key && this.status.state !== 'error') return this.readyPromise;
    this.readyPromise = this._start(cfg, key);
    return this.readyPromise;
  }

  async _start(cfg, key) {
    await this._killServer();
    this.cfg = cfg;
    this.cfgKey = key;
    this._setStatus({ state: 'starting', mode: null, error: null });
    try {
      const external = process.env.CALLASIDE_WHISPER_URL;
      if (external) {
        this.mode = 'external';
        this.baseUrl = external.replace(/\/$/, '');
        await this._waitForHttp(null, 30000);
      } else {
        if (!cfg.modelPath || !fs.existsSync(cfg.modelPath)) {
          throw new Error('The speech model is not downloaded yet.');
        }
        const { server, cli } = await this.resolveBinaries();
        if (server) {
          this.mode = 'server';
          await this._startServer(server, cfg);
        } else if (cli) {
          this.mode = 'cli';
          this.cliPath = cli;
        } else {
          throw new Error('Whisper is not installed. Run ./setup.sh in the callaside folder.');
        }
      }
      this._setStatus({ state: 'ready', mode: this.mode, error: null });
      this._pump();
    } catch (err) {
      this._setStatus({ state: 'error', mode: this.mode || null, error: err.message });
      throw err;
    }
  }

  async _startServer(bin, cfg) {
    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    const args = [
      '-m', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(cfg.threads || 4),
      '-l', cfg.language || 'en',
      '-sns',
    ];
    const env = await this.getEnv();
    const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.serverLog = '';
    const keepTail = (d) => {
      this.serverLog = (this.serverLog + d.toString('utf8')).slice(-4000);
    };
    proc.stdout.on('data', keepTail);
    proc.stderr.on('data', keepTail);
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) {
        this.proc = null;
        if (this.status.state === 'ready') {
          this._setStatus({ state: 'error', error: `whisper-server stopped (code ${code ?? signal}).` });
          this.readyPromise = null;
        }
      }
    });
    await this._waitForHttp(proc, 120000);
  }

  async _waitForHttp(proc, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (proc && proc.exitCode !== null) {
        const tail = (this.serverLog || '').trim().split('\n').slice(-3).join(' ');
        throw new Error(`whisper-server could not start. ${tail}`.trim());
      }
      try {
        const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(1500) });
        await res.arrayBuffer().catch(() => {});
        if (res.status < 500) return;
      } catch {
        // not listening yet
      }
      await sleep(300);
    }
    throw new Error('Timed out waiting for whisper-server to load the model.');
  }

  enqueue(segment) {
    this.queue.push(segment);
    this._setStatus({});
    this._pump();
  }

  // Resolves when every queued segment has been transcribed (or timeout).
  async drain(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while ((this.queue.length || this.busy) && Date.now() < until) await sleep(100);
  }

  async _pump() {
    if (this.busy || !this.queue.length || this.status.state !== 'ready') return;
    this.busy = true;
    const seg = this.queue.shift();
    this._setStatus({});
    try {
      const raw = await this._transcribe(seg);
      const text = cleanText(raw);
      if (text && !isHallucination(text, seg.speechMs)) {
        this.emit('line', { source: seg.source, startMs: seg.startMs, endMs: seg.endMs, speechMs: seg.speechMs, text });
      }
    } catch (err) {
      this.emit('segment-error', { source: seg.source, error: err.message });
    } finally {
      this.busy = false;
      this._setStatus({});
      setImmediate(() => this._pump());
    }
  }

  async _transcribe(seg) {
    const wav = encodeWav(seg.samples);
    if (this.mode === 'cli') return this._transcribeCli(wav);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('language', this.cfg?.language || 'en');
    if (this.cfg?.prompt) form.append('prompt', this.cfg.prompt);
    const res = await fetch(`${this.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    return parseInferenceBody(res.status, body);
  }

  async _transcribeCli(wav) {
    const base = path.join(os.tmpdir(), `callaside-${process.pid}-${++this.counter}`);
    const wavPath = `${base}.wav`;
    fs.writeFileSync(wavPath, wav);
    const args = [
      '-m', this.cfg.modelPath,
      '-f', wavPath,
      '-l', this.cfg.language || 'en',
      '-t', String(this.cfg.threads || 4),
      '-nt', '-np', '-sns',
      '-otxt', '-of', base,
    ];
    if (this.cfg.prompt) args.push('--prompt', this.cfg.prompt);
    const env = await this.getEnv();
    try {
      await new Promise((resolve, reject) => {
        execFile(this.cliPath, args, { env, timeout: 90000 }, (err, _so, se) => {
          if (err) reject(new Error(`whisper-cli failed: ${String(se || err.message).slice(-300)}`));
          else resolve();
        });
      });
      return fs.readFileSync(`${base}.txt`, 'utf8');
    } finally {
      for (const f of [wavPath, `${base}.txt`]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    }
  }

  clearQueue() {
    this.queue = [];
    this._setStatus({});
  }

  async _killServer() {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        p.kill('SIGTERM');
      } catch {
        resolve();
      }
    });
  }

  async stop() {
    this.readyPromise = null;
    this.cfgKey = null;
    await this._killServer();
    this.queue = [];
    this._setStatus({ state: 'idle', mode: null, error: null });
  }
}

function parseInferenceBody(status, body) {
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    if (status >= 400) throw new Error(`whisper-server error ${status}: ${body.slice(0, 200)}`);
    return body;
  }
  if (data && data.error) throw new Error(`whisper-server: ${data.error}`);
  if (status >= 400) throw new Error(`whisper-server error ${status}`);
  if (typeof data?.text === 'string') return data.text;
  if (Array.isArray(data?.segments)) return data.segments.map((s) => s.text || '').join(' ');
  if (Array.isArray(data?.transcription)) return data.transcription.map((s) => s.text || '').join(' ');
  return '';
}

const ANNOTATION = /\[(?:blank_audio|music|noise|silence|inaudible|applause|laughter|laughs|typing|no speech|sound)[^\]]*\]/gi;
const PAREN_ANNOTATION = /\((?:music|silence|inaudible|applause|laughs?|laughter|noise|background noise|typing|static|sighs?|coughs?)[^)]*\)/gi;

function cleanText(raw) {
  return String(raw || '')
    .replace(ANNOTATION, ' ')
    .replace(PAREN_ANNOTATION, ' ')
    .replace(/\*[^*]{0,40}\*/g, ' ')
    .replace(/♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic Whisper hallucinations on noise. Real short words like "Thank you."
// are kept unless they sit on almost no speech.
const HALLUCINATIONS = [
  /^thanks? (?:you )?(?:so much )?for watching[.!]*$/i,
  /subtitles? (?:by|created)/i,
  /amara\.org/i,
  /please (?:like and )?subscribe/i,
  /^(?:thank you\.?\s*){3,}$/i,
  /^music[.!]*$/i,
];

function isHallucination(text, speechMs = 1000) {
  if (!text) return true;
  if (/^[\s.,!?…\-–—'"]*$/.test(text)) return true;
  if (HALLUCINATIONS.some((r) => r.test(text))) return true;
  if (speechMs < 700 && /^(?:you|bye|uh|um|hmm|so)[.!?]*$/i.test(text)) return true;
  return false;
}

// Whisper reads the prompt as the words just before the audio. A list left open
// made it carry on in silence, with lines like "and the other one", and a full
// stop ends that without costing any names.
function whisperPrompt(words) {
  const list = words.slice(0, 600).replace(/[\s,.]+$/, '');
  return list && `${list}.`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Transcriber, cleanText, isHallucination, parseInferenceBody, whisperPrompt };

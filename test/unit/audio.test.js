'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Segmenter } = require('../../src/main/audio/segmenter');
const { encodeWav, decodeWav } = require('../../src/main/audio/wav');

const SR = 16000;

function speech(seconds, rms = 0.08, f0 = 160) {
  const n = Math.round(seconds * SR);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4.5 * t);
    const v = (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)) * env;
    out[i] = Math.round(v * rms * 1.6 * 32767);
  }
  return out;
}

function silence(seconds, noise = 0) {
  const n = Math.round(seconds * SR);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = noise ? Math.round((Math.random() * 2 - 1) * noise * 32767) : 0;
  return out;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function feed(seg, samples, chunk = 1600) {
  for (let i = 0; i < samples.length; i += chunk) seg.push(samples.subarray(i, i + chunk));
}

test('segmenter finds utterances, drops clicks and splits monologues', () => {
  const seg = new Segmenter({ source: 'them', baseMs: 0 });
  const out = [];
  seg.on('segment', (s) => out.push(s));
  const audio = concat([
    silence(1, 0.001),
    speech(2),
    silence(1, 0.001),
    speech(0.12), // click
    silence(1, 0.001),
    speech(17),
    silence(1, 0.001),
  ]);
  feed(seg, audio);
  seg.flush();
  assert.strictEqual(out.length, 3, `got ${out.map((s) => `${s.startMs}-${s.endMs}`).join(', ')}`);
  const [a, b, c] = out;
  assert.ok(a.startMs >= 700 && a.startMs <= 1000, `first start ${a.startMs}`);
  assert.ok(a.endMs >= 3000 && a.endMs <= 3400, `first end ${a.endMs}`);
  assert.ok(b.endMs - b.startMs <= 14000, 'long speech is cut at the hard maximum');
  assert.ok(c.startMs >= b.endMs - 40, 'second half follows the first');
  assert.ok(Math.abs(c.endMs - 22100) < 600, `monologue ends near 22.1s, got ${c.endMs}`);
  for (const s of out) assert.strictEqual(s.samples.length, ((s.endMs - s.startMs) / 1000) * SR);
});

test('segmenter reports levels and offsets by baseMs', () => {
  const seg = new Segmenter({ source: 'you', baseMs: 5000 });
  const levels = [];
  const segs = [];
  seg.on('level', (l) => levels.push(l));
  seg.on('segment', (s) => segs.push(s));
  feed(seg, concat([silence(0.5), speech(1.5), silence(1)]));
  assert.ok(levels.length >= 25);
  assert.ok(levels.some((l) => l.speaking));
  assert.strictEqual(segs.length, 1);
  // Speech starts at 500 ms; the segment includes ~240 ms of pre-roll before it.
  assert.ok(segs[0].startMs >= 5000 + 150 && segs[0].startMs <= 5000 + 500, `start ${segs[0].startMs}`);
});

test('segmenter ignores steady background noise', () => {
  const seg = new Segmenter({ source: 'you', baseMs: 0 });
  const segs = [];
  seg.on('segment', (s) => segs.push(s));
  feed(seg, silence(10, 0.0025));
  seg.flush();
  assert.strictEqual(segs.length, 0);
});

test('wav round trip and resampling', () => {
  const src = speech(1);
  const back = decodeWav(encodeWav(src)).samples;
  assert.strictEqual(back.length, src.length);
  assert.ok(Math.abs(back[1234] - src[1234]) <= 1);

  // 48 kHz stereo 16-bit
  const frames = 48000;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(48000 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  const dec = decodeWav(buf);
  assert.strictEqual(dec.samples.length, 16000);
});

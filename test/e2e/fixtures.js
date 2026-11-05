'use strict';

// Builds a synthetic two-track "call" plus a stand-in whisper-server for
// end-to-end tests. Each utterance has a unique length, so the stand-in
// server can tell which line a segment holds from its duration alone.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { encodeWav } = require('../../src/main/audio/wav');

const SR = 16000;

const SCRIPT = [
  { source: 'them', at: 1.0, dur: 4.2, text: 'Thanks for jumping on. We run twelve physiotherapy clinics across Sydney and Melbourne.' },
  { source: 'you', at: 6.2, dur: 2.6, text: 'Great to meet you. What made you reach out this week?' },
  { source: 'them', at: 9.8, dur: 3.8, text: 'Our front desk spends about four hours a day on booking calls and reminder texts.' },
  { source: 'them', at: 14.5, dur: 5.0, text: 'We want an AI receptionist that books straight into Cliniko and picks up the phone after hours.' },
  { source: 'you', at: 20.5, dur: 3.0, text: 'Got it. Are most of those calls new patients or existing ones rescheduling?' },
  { source: 'them', at: 24.5, dur: 4.6, text: 'Mostly existing patients. And we have to stay inside the Australian privacy rules.' },
  { source: 'them', at: 30.0, dur: 3.4, text: 'Have you built something like this before, and how long would it take?' },
];
const TOTAL_S = 35;

function voice(buf, startS, durS, { rms = 0.08, f0 = 150, gain = 1 } = {}) {
  const s0 = Math.round(startS * SR);
  const n = Math.round(durS * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const env = (0.6 + 0.4 * Math.sin(2 * Math.PI * 4.3 * t)) * Math.min(1, t * 20, (durS - t) * 20);
    const v = (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2.02 * f0 * t)) * env * rms * 1.6 * gain;
    buf[s0 + i] += v;
  }
}

function toInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767);
  return out;
}

function makeCallAudio(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const them = new Float32Array(TOTAL_S * SR);
  const you = new Float32Array(TOTAL_S * SR);
  for (let i = 0; i < you.length; i++) you[i] = (Math.random() * 2 - 1) * 0.001; // room noise on the mic
  for (const u of SCRIPT) voice(u.source === 'them' ? them : you, u.at, u.dur, { f0: u.source === 'them' ? 190 : 125 });
  // Speaker bleed: the mic also picks up the first thing they said, quieter.
  voice(you, SCRIPT[0].at, SCRIPT[0].dur, { f0: 190, gain: 0.3 });
  const themFile = path.join(dir, 'them.wav');
  const youFile = path.join(dir, 'you.wav');
  fs.writeFileSync(themFile, encodeWav(toInt16(them)));
  fs.writeFileSync(youFile, encodeWav(toInt16(you)));
  return { themFile, youFile };
}

// Stand-in for whisper-server's GET / and POST /inference.
function startMockWhisper() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html>whisper.cpp server</html>');
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const i = body.indexOf('RIFF');
      const bytes = i >= 0 ? body.readUInt32LE(i + 40) : 0;
      const seconds = bytes / 2 / SR;
      // Segments carry ~0.5 s of pre-roll and tail around the speech.
      let best = null;
      for (const u of SCRIPT) {
        const d = Math.abs(u.dur + 0.5 - seconds);
        if (!best || d < best.d) best = { u, d };
      }
      const text = best && best.d < 0.35 ? best.u.text : '';
      requests.push({ seconds: Number(seconds.toFixed(2)), text });
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: ` ${text}` }));
      }, 120);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => srv.close() });
    });
  });
}

module.exports = { SCRIPT, makeCallAudio, startMockWhisper };

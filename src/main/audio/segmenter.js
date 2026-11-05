'use strict';

const { EventEmitter } = require('events');

// Splits a live 16 kHz PCM stream into speech segments using an adaptive
// energy detector. Each segment is sent to Whisper on its own, so a line of
// transcript appears shortly after the speaker pauses.
//
// Events:
//   'level'   { source, rms, speaking }            ~10 times a second
//   'segment' { source, startMs, endMs, speechMs, samples: Int16Array }

class Segmenter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.source = opts.source || 'unknown';
    this.sampleRate = opts.sampleRate || 16000;
    this.frameSize = Math.round((this.sampleRate * (opts.frameMs || 20)) / 1000);
    this.frameMs = (1000 * this.frameSize) / this.sampleRate;
    this.minSpeechMs = opts.minSpeechMs ?? 300; // shorter bursts are treated as noise
    this.endSilenceMs = opts.endSilenceMs ?? 650; // pause that closes a segment
    this.softMaxMs = opts.softMaxMs ?? 7000; // after this, close on any short pause
    this.softPauseMs = opts.softPauseMs ?? 240;
    this.maxSegmentMs = opts.maxSegmentMs ?? 14000; // hard cut for long monologues
    this.preRollFrames = Math.round((opts.preRollMs ?? 240) / this.frameMs);
    this.tailFrames = Math.round((opts.tailMs ?? 240) / this.frameMs);
    this.absThreshold = opts.absThreshold ?? 0.004; // RMS on a 0..1 scale
    this.floorMultiplier = opts.floorMultiplier ?? 3;
    this.noiseFloor = opts.initialNoiseFloor ?? 0.002;
    this.now = opts.now || null; // () => ms since call start, used to align sources
    this.baseMs = opts.baseMs ?? null;
    this._reset();
  }

  _reset() {
    this.pending = new Int16Array(0);
    this.framesSeen = 0;
    this.preRoll = [];
    this.onset = [];
    this.inSegment = false;
    this.segFrames = [];
    this.segStartFrame = 0;
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.levelMax = 0;
    this.levelFrames = 0;
  }

  push(samples) {
    if (!samples || !samples.length) return;
    if (this.baseMs === null) {
      const chunkMs = (samples.length / this.sampleRate) * 1000;
      this.baseMs = this.now ? Math.max(0, this.now() - chunkMs) : 0;
    }
    let data = samples;
    if (this.pending.length) {
      data = new Int16Array(this.pending.length + samples.length);
      data.set(this.pending);
      data.set(samples, this.pending.length);
    }
    let off = 0;
    while (off + this.frameSize <= data.length) {
      this._frame(data.subarray(off, off + this.frameSize));
      off += this.frameSize;
    }
    this.pending = data.slice(off);
  }

  _frame(frame) {
    const idx = this.framesSeen++;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frame.length);
    const threshold = Math.max(this.absThreshold, this.noiseFloor * this.floorMultiplier);
    const isSpeech = rms > threshold;

    if (!this.inSegment) {
      if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
      else if (!isSpeech) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
      this.noiseFloor = Math.min(Math.max(this.noiseFloor, 0.0003), 0.03);
    }

    this.levelMax = Math.max(this.levelMax, rms);
    if (++this.levelFrames >= 5) {
      this.emit('level', { source: this.source, rms: this.levelMax, speaking: this.inSegment });
      this.levelMax = 0;
      this.levelFrames = 0;
    }

    const copy = new Int16Array(frame);
    if (!this.inSegment) {
      this.onset.push(isSpeech);
      if (this.onset.length > 5) this.onset.shift();
      this.preRoll.push(copy);
      if (this.preRoll.length > this.preRollFrames + 5) this.preRoll.shift();
      const speechCount = this.onset.reduce((n, s) => n + (s ? 1 : 0), 0);
      if (speechCount >= 3) {
        this.inSegment = true;
        this.segFrames = this.preRoll;
        this.segStartFrame = idx - this.segFrames.length + 1;
        this.speechFrames = speechCount;
        this.silenceRun = 0;
        this.preRoll = [];
        this.onset = [];
      }
      return;
    }

    this.segFrames.push(copy);
    if (isSpeech) {
      this.speechFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }
    const durMs = this.segFrames.length * this.frameMs;
    const silenceMs = this.silenceRun * this.frameMs;
    if (
      silenceMs >= this.endSilenceMs ||
      (durMs >= this.softMaxMs && silenceMs >= this.softPauseMs) ||
      durMs >= this.maxSegmentMs
    ) {
      this._endSegment();
    }
  }

  _endSegment() {
    let frames = this.segFrames;
    const extraSilence = this.silenceRun - this.tailFrames;
    if (extraSilence > 0) frames = frames.slice(0, frames.length - extraSilence);
    const speechMs = this.speechFrames * this.frameMs;
    const startMs = (this.baseMs || 0) + this.segStartFrame * this.frameMs;
    const endMs = startMs + frames.length * this.frameMs;
    this.inSegment = false;
    this.segFrames = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    if (speechMs < this.minSpeechMs) return;
    let total = 0;
    for (const f of frames) total += f.length;
    const samples = new Int16Array(total);
    let o = 0;
    for (const f of frames) {
      samples.set(f, o);
      o += f.length;
    }
    this.emit('segment', {
      source: this.source,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      speechMs: Math.round(speechMs),
      samples,
    });
  }

  // Closes any open segment, e.g. when the call stops.
  flush() {
    if (this.inSegment) this._endSegment();
  }
}

module.exports = { Segmenter };

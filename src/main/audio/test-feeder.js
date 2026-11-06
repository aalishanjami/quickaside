'use strict';

const fs = require('fs');
const { decodeWav } = require('./wav');

// Plays a WAV file into a segmenter in real time (or faster), standing in for
// the microphone or call audio. Used for testing without a live call:
//   QUICKASIDE_TEST_AUDIO_THEM=/path/them.wav QUICKASIDE_TEST_AUDIO_YOU=/path/you.wav npm start

class WavFeeder {
  constructor(file, { speed = 1, chunkMs = 100 } = {}) {
    this.samples = decodeWav(fs.readFileSync(file)).samples;
    this.speed = Math.max(0.1, speed);
    this.chunk = Math.round((16000 * chunkMs) / 1000);
    this.chunkMs = chunkMs;
    this.pos = 0;
    this.timer = null;
  }

  start(onData, onEnd) {
    this.stop();
    this.timer = setInterval(() => {
      if (this.pos >= this.samples.length) {
        this.stop();
        if (onEnd) onEnd();
        return;
      }
      const end = Math.min(this.samples.length, this.pos + this.chunk);
      onData(this.samples.slice(this.pos, end));
      this.pos = end;
    }, this.chunkMs / this.speed);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { WavFeeder };

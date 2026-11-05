'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');

// Captures what the Mac is playing (the other side of the call) with AudioTee,
// a small Swift tool that uses Core Audio taps (macOS 14.2+). It needs the
// "System Audio Recording Only" permission, not Screen Recording.
//
// Events: 'data' (Int16Array, 16 kHz mono), 'started', 'error' (Error), 'exit'

class SystemAudio extends EventEmitter {
  constructor({ binaryPath, env } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.env = env;
    this.proc = null;
    this.remainder = null;
    this.stopping = false;
    this.bytes = 0;
    this.nonZero = false;
  }

  start() {
    if (this.proc) return;
    if (process.platform !== 'darwin') {
      throw new Error('Call audio capture needs macOS 14.2 or later.');
    }
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) {
      throw new Error('AudioTee is missing. Run npm install in the app folder.');
    }
    this.stopping = false;
    const args = ['--sample-rate', '16000', '--chunk-duration', '0.1'];
    this.proc = spawn(this.binaryPath, args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    let errBuf = '';
    this.proc.stderr.on('data', (d) => {
      errBuf += d.toString('utf8');
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (line) this._onLog(line);
      }
    });
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.proc = null;
      if (!wasStopping && code !== 0) {
        this.emit('error', new Error(`AudioTee stopped (code ${code}${signal ? `, ${signal}` : ''}).`));
      }
      this.emit('exit', { code, signal });
    });
  }

  _onLog(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.message_type === 'stream_start') this.emit('started');
    else if (msg.message_type === 'error') this.emit('error', new Error(msg.data?.message || 'AudioTee error'));
  }

  _onData(chunk) {
    let buf = chunk;
    if (this.remainder) {
      buf = Buffer.concat([this.remainder, chunk]);
      this.remainder = null;
    }
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) this.remainder = buf.subarray(usable);
    if (!usable) return;
    // Copy into an aligned buffer before viewing it as 16-bit samples.
    const aligned = new Int16Array(usable / 2);
    Buffer.from(aligned.buffer).set(buf.subarray(0, usable));
    this.bytes += usable;
    if (!this.nonZero) {
      for (let i = 0; i < aligned.length; i++) {
        if (aligned[i] !== 0) {
          this.nonZero = true;
          break;
        }
      }
    }
    this.emit('data', aligned);
  }

  // True once any non-silent sample arrived. AudioTee records pure silence
  // when the permission is missing, so this helps explain a flat meter.
  hasHeardAudio() {
    return this.nonZero;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      this.stopping = true;
      const p = this.proc;
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
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
}

module.exports = { SystemAudio };

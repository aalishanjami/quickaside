'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A small rotating log for bug reports. It records what the app did, never what
// was said: call log.* with states, counts and timings only, and never pass
// transcripts, answers, notes, prompts or file contents to it.

const MAX_BYTES = 1024 * 1024;
const MAX_VALUE = 200;

function clean(value) {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '')
    .split(os.homedir())
    .join('~')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_VALUE);
}

class Log {
  constructor(dir, { maxBytes = MAX_BYTES } = {}) {
    this.file = path.join(dir, 'main.log');
    this.old = path.join(dir, 'main.old.log');
    this.maxBytes = maxBytes;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  _write(level, event, fields) {
    const parts = Object.entries(fields || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${clean(v)}`);
    const line = `${new Date().toISOString()} ${level} ${event}${parts.length ? ` ${parts.join(' ')}` : ''}\n`;
    // A log that can't be written must never take the app down with it.
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + line.length > this.maxBytes) fs.renameSync(this.file, this.old);
      fs.appendFileSync(this.file, line);
    } catch {}
  }

  info(event, fields) {
    this._write('INFO', event, fields);
  }

  warn(event, fields) {
    this._write('WARN', event, fields);
  }

  error(event, fields) {
    this._write('ERROR', event, fields);
  }

  // The last lines across both files, oldest first.
  tail(count = 150) {
    const read = (f) => {
      try {
        return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    return [...read(this.old), ...read(this.file)].slice(-count).join('\n');
  }
}

module.exports = { Log, clean };

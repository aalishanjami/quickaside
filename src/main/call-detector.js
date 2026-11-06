'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

// Watches which apps have the microphone open, through the small Swift helper
// in scripts/call-detector.swift, and turns that into call started and call
// ended events. Only known call apps count, so dictation or a voice memo does
// not raise a prompt.
//
// Events: 'call' { name }, 'ended', 'status'

// Dedicated apps come first, so Zoom wins when a browser also has the mic.
// Electron apps capture from a helper process, which shares the id as a prefix.
const CALL_APPS = [
  ['us.zoom.', 'Zoom'],
  ['com.microsoft.teams', 'Teams'],
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['com.apple.FaceTime', 'FaceTime'],
  ['com.apple.avconferenced', 'FaceTime'],
  ['Cisco-Systems.Spark', 'Webex'],
  ['com.webex.', 'Webex'],
  ['com.hnc.Discord', 'Discord'],
  ['net.whatsapp.WhatsApp', 'WhatsApp'],
  ['desktop.WhatsApp', 'WhatsApp'],
  ['com.skype.', 'Skype'],
  ['org.whispersystems.signal-desktop', 'Signal'],
  ['ru.keepcoder.Telegram', 'Telegram'],
  ['com.google.Chrome', 'Chrome'],
  ['company.thebrowser.Browser', 'Arc'],
  ['com.brave.Browser', 'Brave'],
  ['com.microsoft.edgemac', 'Edge'],
  ['org.mozilla.firefox', 'Firefox'],
  ['com.operasoftware.', 'Opera'],
  ['com.apple.Safari', 'Safari'],
  ['com.apple.WebKit.GPU', 'Safari'], // Safari's audio runs in this process
];

// This app's own mic capture must never count as a call.
const OWN_IDS = ['io.github.aalishanjami.quickaside', 'com.github.Electron'];

function callAppName(ids) {
  const others = ids.filter((id) => !OWN_IDS.some((own) => id.startsWith(own)));
  for (const [prefix, name] of CALL_APPS) {
    if (others.some((id) => id.startsWith(prefix))) return name;
  }
  return null;
}

class CallDetector extends EventEmitter {
  // holdMs: the mic has to stay open this long, so a quick mic test does not count.
  // endMs: and stay closed this long, so switching devices does not end the call.
  constructor({ resolveBinary, holdMs = 3000, endMs = 15000, retryMs = 5000, maxRetries = 5 }) {
    super();
    this.resolveBinary = resolveBinary;
    this.holdMs = holdMs;
    this.endMs = endMs;
    this.retryMs = retryMs;
    this.maxRetries = maxRetries;
    this.state = 'off'; // off | on | missing
    this.current = null; // name of the app the call is in
    this.pending = null;
    this.proc = null;
    this.buffer = '';
    this.retries = 0;
    this.holdTimer = null;
    this.endTimer = null;
    this.retryTimer = null;
    this.wanted = false;
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.emit('status');
  }

  async start() {
    this.wanted = true;
    if (this.proc) return;
    const bin = await this.resolveBinary();
    if (!this.wanted || this.proc) return;
    if (!bin) return this._setState('missing');
    const proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = proc;
    this.buffer = '';
    proc.stdout.on('data', (d) => this._onData(d));
    proc.on('error', () => this._onExit(proc));
    proc.on('exit', () => this._onExit(proc));
    this._setState('on');
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.holdTimer);
    clearTimeout(this.endTimer);
    this.holdTimer = this.endTimer = null;
    this.pending = null;
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    this._setState('off');
    if (this.current) {
      this.current = null;
      this.emit('ended');
    }
  }

  _onExit(proc) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (!this.wanted) return;
    if (this.retries >= this.maxRetries) return this._setState('missing');
    this.retries++;
    this.retryTimer = setTimeout(() => this.start().catch(() => {}), this.retryMs);
  }

  _onData(data) {
    this.buffer += data.toString('utf8');
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      try {
        const ids = JSON.parse(line);
        if (Array.isArray(ids)) {
          this.retries = 0;
          this.update(ids);
        }
      } catch {
        // a broken line: the next change sends the full list again
      }
    }
  }

  update(ids) {
    const name = callAppName(ids);
    if (name) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
      this.pending = name;
      if (this.current) {
        this.current = name;
      } else if (!this.holdTimer) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.current = this.pending;
          this.emit('call', { name: this.current });
        }, this.holdMs);
      }
      return;
    }
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pending = null;
    if (this.current && !this.endTimer) {
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        this.current = null;
        this.emit('ended');
      }, this.endMs);
    }
  }
}

module.exports = { CallDetector, callAppName };

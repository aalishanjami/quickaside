'use strict';

const { EventEmitter } = require('events');

// Keeps the app current through Electron's free update service, which reads
// GitHub Releases of a public repo. It never installs or even checks during a
// call: once downloaded, an update installs on the next quit or on request.
//
// Events: 'status', 'install-failed'

const FEED = 'https://update.electronjs.org';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function repoFromIssues(url) {
  const m = String(url).match(/github\.com\/([^/]+\/[^/]+)/);
  return m ? m[1] : null;
}

class Updater extends EventEmitter {
  constructor({ autoUpdater, repo, version, arch = 'arm64', enabled, isBusy, log, feed = FEED, firstCheckMs = FIRST_CHECK_MS, checkEveryMs = CHECK_EVERY_MS }) {
    super();
    Object.assign(this, { autoUpdater, repo, version, arch, enabled, isBusy, log, feed, firstCheckMs, checkEveryMs });
    this.state = 'off'; // off | idle | checking | downloading | ready
    this.installing = false;
    this.timers = [];
  }

  _set(state) {
    if (state === this.state) return;
    this.state = state;
    this.log.info('update.state', { state });
    this.emit('status');
  }

  start() {
    if (!this.enabled || !this.repo) return;
    const a = this.autoUpdater;
    a.on('checking-for-update', () => this._set('checking'));
    a.on('update-available', () => this._set('downloading'));
    a.on('update-not-available', () => this._set('idle'));
    a.on('update-downloaded', () => this._set('ready'));
    a.on('error', (err) => this._onError(err));
    try {
      a.setFeedURL({ url: `${this.feed}/${this.repo}/darwin-${this.arch}/${this.version}` });
    } catch (err) {
      return this.log.warn('update.feed', { error: err }); // an unsigned build lands here
    }
    this._set('idle');
    this.timers.push(setTimeout(() => this.check(), this.firstCheckMs));
    this.timers.push(setInterval(() => this.check(), this.checkEveryMs));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  _onError(err) {
    this.log.warn('update.error', { error: err, installing: this.installing });
    if (this.installing) {
      this.installing = false;
      return this.emit('install-failed');
    }
    if (this.state !== 'ready') this._set('idle');
  }

  check() {
    if (this.state !== 'idle' || this.isBusy()) return false;
    try {
      this.autoUpdater.checkForUpdates();
      return true;
    } catch (err) {
      this._onError(err);
      return false;
    }
  }

  // beforeInstall runs first, so the caller can let its windows really close.
  install(beforeInstall) {
    if (this.state !== 'ready' || this.isBusy()) return false;
    this.installing = true;
    beforeInstall();
    this.log.info('update.install');
    this.autoUpdater.quitAndInstall();
    return true;
  }
}

module.exports = { Updater, repoFromIssues };

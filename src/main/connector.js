'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { TOOLS } = require('../connector/tools');
const { NAME } = require('../connector/server');
const { CONNECTOR_FLAG } = require('./launch');

// Sets up the read-only server in src/connector for the user's own Claude.
// Nothing here runs by itself: each step follows a click in Settings.

const SRC = path.join(__dirname, '..');
const BUNDLE_FILES = ['connector/server.js', 'connector/tools.js', 'main/calls.js', 'main/transcript.js'];
const CLAUDE_TIMEOUT_MS = 20000;

function run(bin, args, options) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: CLAUDE_TIMEOUT_MS, ...options }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout), err: String(stderr) });
    });
  });
}

// The app's own binary runs the server, so nobody needs Node installed. It can't
// run as plain Node: build-mac-app.sh turns that off. Outside a build, Electron
// needs telling which app to run.
function serverConfig({ execPath, appPath, packaged, dataDir }) {
  return {
    type: 'stdio',
    command: execPath,
    args: [...(packaged ? [] : [appPath]), CONNECTOR_FLAG, '--data', dataDir],
  };
}

function bundleManifest({ version, dataDir }) {
  const entry = 'server/src/connector/server.js';
  return {
    manifest_version: '0.3',
    name: NAME,
    display_name: 'Callaside',
    version,
    description: 'Search your saved calls, transcripts and notes. Read only, and it runs on this Mac.',
    author: { name: 'Callaside' },
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: entry,
      mcp_config: { command: 'node', args: [`\${__dirname}/${entry}`, '--data', dataDir] },
    },
    tools: TOOLS.map(({ name, description }) => ({ name, description })),
    compatibility: { platforms: ['darwin'] },
    license: 'MIT',
  };
}

// The folder that becomes the .mcpb. Paths match src/, so requires still resolve.
function stageBundle(stage, { version, dataDir }) {
  fs.rmSync(stage, { recursive: true, force: true });
  for (const file of BUNDLE_FILES) {
    const to = path.join(stage, 'server', 'src', file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SRC, file), to);
  }
  fs.copyFileSync(path.join(SRC, 'assets', 'icon.png'), path.join(stage, 'icon.png'));
  fs.writeFileSync(path.join(stage, 'server', 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(bundleManifest({ version, dataDir }), null, 2));
}

class Connector {
  constructor({ resolveClaude, getEnv, execPath, appPath, packaged, dataDir, version }) {
    this.resolveClaude = resolveClaude;
    this.getEnv = getEnv;
    this.config = serverConfig({ execPath, appPath, packaged, dataDir });
    this.dataDir = dataDir;
    this.version = version;
  }

  // Run from the data folder: Claude's working folder must never be a protected one.
  async _claude(args) {
    const bin = await this.resolveClaude();
    if (!bin) return null;
    return run(bin, ['mcp', ...args], { cwd: this.dataDir, env: await this.getEnv() });
  }

  // missing: no Claude Code. off: not set up. moved: set up for another copy of
  // the app. failed: set up, but Claude Code's health check could not start it.
  async claudeCodeStatus() {
    const result = await this._claude(['get', NAME]);
    if (!result) return 'missing';
    if (!result.ok) return 'off';
    if (!result.out.includes(this.config.command) || !result.out.includes(CONNECTOR_FLAG)) return 'moved';
    return /Status:.*\bConnected\b/.test(result.out) ? 'connected' : 'failed';
  }

  async connectClaudeCode() {
    await this._claude(['remove', NAME, '--scope', 'user']); // Claude Code refuses to add over an old entry
    const result = await this._claude(['add-json', NAME, JSON.stringify(this.config), '--scope', 'user']);
    if (!result) throw new Error('Claude Code was not found.');
    if (!result.ok) throw new Error(result.err.trim() || 'Claude Code did not accept the connector.');
  }

  async disconnectClaudeCode() {
    const result = await this._claude(['remove', NAME, '--scope', 'user']);
    if (!result) throw new Error('Claude Code was not found.');
    if (!result.ok) throw new Error(result.err.trim() || 'Claude Code did not remove the connector.');
  }

  // Claude Desktop installs a .mcpb when it is opened, and asks the user first.
  async buildBundle() {
    const folder = path.join(this.dataDir, 'connector');
    const stage = path.join(folder, 'bundle');
    const file = path.join(folder, 'Callaside.mcpb');
    stageBundle(stage, { version: this.version, dataDir: this.dataDir });
    fs.rmSync(file, { force: true });
    // -D leaves out folder entries: the mcpb unpacker fails on them, so ditto won't do.
    const zipped = await run('/usr/bin/zip', ['-q', '-r', '-D', '-X', file, '.'], { cwd: stage });
    if (!zipped.ok) throw new Error('Could not build the connector file.');
    return file;
  }
}

module.exports = { Connector, serverConfig, bundleManifest, stageBundle };

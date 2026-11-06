'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repoFromIssues, Updater } = require('../../src/main/updater');
const { bugs } = require('../../package.json');

const ROOT = path.join(__dirname, '../..');
const INSTALL = path.join(ROOT, 'scripts/install.sh');
const script = (name) => fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');

// Stand-ins for the macOS tools, so these tests run anywhere. Each one logs its
// arguments, and FAKE_* variables choose what goes wrong.
const LOG = 'echo "$(basename "$0") $*" >> "$FAKE_LOG"\n';

const TOOLS = {
  uname: 'case "$1" in -s) echo "${FAKE_OS:-Darwin}";; -m) echo "${FAKE_ARCH:-arm64}";; esac\n',
  sw_vers: 'echo "${FAKE_MACOS:-15.1}"\n',
  sleep: 'exit 0\n',
  curl: `${LOG}case "$*" in
  *" -w "*)
    [ -z "$FAKE_OFFLINE" ] || exit 6
    echo "\${FAKE_LATEST:-https://github.com/o/r/releases/tag/v1.2.3}"
    ;;
  *)
    [ -z "$FAKE_CUT_OFF" ] || exit 18
    while [ "$1" != "-o" ]; do shift; done
    echo zip > "$2"
    ;;
esac\n`,
  ditto: `${LOG}if [ "$1" = "-x" ]; then
  [ -z "$FAKE_DAMAGED" ] || exit 1
  mkdir -p "$4/Quickaside.app/Contents"
  echo new > "$4/Quickaside.app/Contents/marker"
else
  mkdir -p "$2"
  cp -R "$1/." "$2/"
fi\n`,
  codesign: `${LOG}[ -z "$FAKE_BAD_SIGNATURE" ] || exit 1\n`,
  osascript: `${LOG}case "$*" in
  *"is running"*)
    if [ -f "$FAKE_RUNNING" ]; then echo true; else echo false; fi
    ;;
  *"to quit"*)
    [ -n "$FAKE_WONT_QUIT" ] || rm -f "$FAKE_RUNNING"
    ;;
esac\n`,
  open: LOG,
};

function run(env = {}, { existing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const [name, body] of Object.entries(TOOLS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}`, { mode: 0o755 });
  }
  const marker = path.join(home, 'Applications', 'Quickaside.app', 'Contents', 'marker');
  if (existing) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'old\n');
  }
  const logFile = path.join(dir, 'log');
  fs.writeFileSync(logFile, '');
  const r = spawnSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_LOG: logFile, FAKE_RUNNING: path.join(dir, 'running'), ...env },
  });
  return { ...r, log: fs.readFileSync(logFile, 'utf8'), installed: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null, dir };
}

test('it downloads the tagged zip, checks the signature, installs and opens', () => {
  const r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.installed, 'new');
  assert.match(r.log, /releases\/download\/v1\.2\.3\/Quickaside-1\.2\.3-mac-arm64\.zip/);
  const certificate = /^CERT="(.*)"$/m.exec(script('install.sh'))[1];
  assert.ok(r.log.includes(`-R=certificate leaf = H"${certificate}"`), r.log);
  const steps = r.log.trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' '));
  assert.ok(steps.indexOf('ditto -x') < steps.findIndex((s) => s.startsWith('codesign')), r.log);
  const copied = steps.findIndex((s) => s.startsWith('ditto /'));
  assert.ok(steps.findIndex((s) => s.startsWith('codesign')) < copied, 'checked before it is copied');
  assert.match(r.log, /open .*Applications\/Quickaside\.app/);
});

test('a download with the wrong signature is never installed', () => {
  const r = run({ FAKE_BAD_SIGNATURE: '1' }, { existing: true });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not signed with this project's certificate/);
  assert.strictEqual(r.installed, 'old');
  assert.doesNotMatch(r.log, /^open /m);
  assert.doesNotMatch(r.log, /to quit/);
});

test('a failed download leaves the old app alone', () => {
  for (const [env, message] of [
    [{ FAKE_OFFLINE: '1' }, /could not find the latest release/],
    [{ FAKE_LATEST: 'https://github.com/o/r/releases' }, /no release was found/],
    [{ FAKE_CUT_OFF: '1' }, /did not finish/],
    [{ FAKE_DAMAGED: '1' }, /damaged/],
  ]) {
    const r = run(env, { existing: true });
    assert.strictEqual(r.status, 1, JSON.stringify(env));
    assert.match(r.stderr, message);
    assert.strictEqual(r.installed, 'old', JSON.stringify(env));
  }
});

test('it refuses a Mac the app cannot run on', () => {
  for (const [env, message] of [
    [{ FAKE_OS: 'Linux' }, /runs on a Mac/],
    [{ FAKE_ARCH: 'x86_64' }, /Apple Silicon/],
    [{ FAKE_MACOS: '14.1' }, /macOS 14\.2 or newer\. This Mac has 14\.1/],
    [{ FAKE_MACOS: '13.7.1' }, /14\.2 or newer/],
    [{ FAKE_MACOS: '14' }, /14\.2 or newer/],
  ]) {
    const r = run(env);
    assert.strictEqual(r.status, 1, JSON.stringify(env));
    assert.match(r.stderr, message);
    assert.strictEqual(r.log, '', 'nothing was downloaded');
  }
});

test('every macOS from 14.2 is allowed', () => {
  for (const version of ['14.2', '14.2.1', '14.7', '15', '15.0', '26.1', '27.0.1']) {
    assert.strictEqual(run({ FAKE_MACOS: version }).status, 0, version);
  }
});

test('a running app is quit before it is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-'));
  const running = path.join(dir, 'running');
  fs.writeFileSync(running, '');
  const r = run({ FAKE_RUNNING: running }, { existing: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Quitting Quickaside/);
  assert.match(r.log, /application id "io\.github\.aalishanjami\.quickaside" to quit/);
  assert.strictEqual(r.installed, 'new');
});

test('an app that will not quit is left in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-'));
  const running = path.join(dir, 'running');
  fs.writeFileSync(running, '');
  const r = run({ FAKE_RUNNING: running, FAKE_WONT_QUIT: '1' }, { existing: true });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /did not quit/);
  assert.strictEqual(r.installed, 'old');
});

test('the temporary folder is cleaned up, even after a failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-'));
  for (const env of [{}, { FAKE_BAD_SIGNATURE: '1' }]) {
    run({ TMPDIR: dir, ...env });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  }
});

test('the whole script is read before anything runs, so a cut-off download does nothing', () => {
  const lines = script('install.sh').trim().split('\n');
  assert.strictEqual(lines[lines.length - 1], 'main "$@"');
  assert.strictEqual(lines.filter((l) => /^main /.test(l)).length, 1);
});

test('the installer, the app and the update service agree on the repo', () => {
  const repo = repoFromIssues(bugs.url);
  const text = script('install.sh');
  assert.strictEqual(/^REPO="(.*)"$/m.exec(text)[1], repo);
  assert.ok(text.includes(`githubusercontent.com/${repo}/main/scripts/install.sh`));
});

test('releases are signed with the certificate the installer checks', () => {
  const text = script('release-mac.sh');
  assert.match(text, /CERT="\$\(sed .*scripts\/install\.sh\)"/);
  assert.match(text, /-R="certificate leaf = H\\"\$CERT\\""/);
  assert.doesNotMatch(text, /--sign -/);
  assert.doesNotMatch(text, /notarytool/);
});

test('whatever loads its own libraries may do so, or it crashes under a self-signed certificate', () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, 'build', `entitlements.${name}.plist`), 'utf8');
  for (const name of ['main', 'helper', 'updater']) assert.match(read(name), /disable-library-validation/, name);
  assert.match(script('release-mac.sh'), /\*\/ShipIt\) sign "\$file" build\/entitlements\.updater\.plist/);
});

test('the build renames the executable, because updates stay off otherwise', () => {
  const text = script('build-mac-app.sh');
  assert.match(text, /mv "\$OUT\/Contents\/MacOS\/Electron" "\$OUT\/Contents\/MacOS\/\$NAME"/);
  assert.match(text, /CFBundleExecutable -string "\$NAME"/);
});

test('the build gives the app its own icon, not Electron\'s', () => {
  const text = script('build-mac-app.sh');
  assert.match(text, /cp build\/icon\.icns "\$RES\/\$NAME\.icns"/);
  assert.match(text, /rm -f "\$RES\/electron\.icns"/);
  assert.match(text, /CFBundleIconFile -string "\$NAME\.icns"/);
  const icns = fs.readFileSync(path.join(ROOT, 'build', 'icon.icns'));
  assert.strictEqual(icns.toString('latin1', 0, 4), 'icns');
  assert.strictEqual(icns.readUInt32BE(4), icns.length);
  for (const type of ['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) {
    assert.ok(icns.includes(Buffer.from(type, 'latin1')), `no ${type} image`);
  }
});

test('the drawn images are the sizes macOS and the bundle expect', () => {
  const width = (file) => {
    const png = fs.readFileSync(path.join(ROOT, 'src', 'assets', file));
    assert.strictEqual(png.toString('latin1', 1, 4), 'PNG', file);
    return png.readUInt32BE(16);
  };
  assert.strictEqual(width('trayTemplate.png'), 16);
  assert.strictEqual(width('trayTemplate@2x.png'), 32);
  assert.strictEqual(width('icon.png'), 512);
});

test('the update feed defaults to the free service and can be pointed at a test server', () => {
  const feed = (extra) => {
    let url = null;
    const u = new Updater({
      autoUpdater: { on() {}, setFeedURL: (o) => (url = o.url) },
      repo: 'o/r',
      version: '1.0.0',
      enabled: true,
      isBusy: () => false,
      log: { info() {}, warn() {} },
      ...extra,
    });
    u.start();
    u.stop();
    return url;
  };
  assert.strictEqual(feed({}), 'https://update.electronjs.org/o/r/darwin-arm64/1.0.0');
  assert.strictEqual(feed({ feed: 'http://127.0.0.1:1' }), 'http://127.0.0.1:1/o/r/darwin-arm64/1.0.0');
});

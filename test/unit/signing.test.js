'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SIGN = path.join(__dirname, '../../scripts/sign-mac-app.sh');
const CREATE = path.join(__dirname, '../../scripts/create-signing-identity.sh');
const HASH = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';

// Stand-ins for the macOS tools. Each one logs its arguments, so these tests
// run anywhere and never touch a real keychain.
const LOG = 'echo "$(basename "$0") $*" >> "$FAKE_LOG"\n';

const TOOLS = {
  uname: 'echo Darwin\n',
  codesign: `${LOG}case "$*" in *"$FAKE_FAIL_SIGN"*) [ -n "$FAKE_FAIL_SIGN" ] && exit 1;; esac\nexit 0\n`,
  security: `${LOG}case "$1" in
  find-identity)
    echo "Policy: Code Signing"
    echo "  Matching identities"
    [ -n "$FAKE_NO_IDENTITY" ] || echo "  1) ${HASH} \\"Quickaside\\" (CSSMERR_TP_NOT_TRUSTED)"
    ;;
  unlock-keychain) [ -z "$FAKE_LOCKED" ] || exit 1 ;;
  list-keychains)
    if [ "$2" = "-d" ] && [ "$#" = 3 ]; then
      echo '    "/Users/me/Library/Keychains/login.keychain-db"'
      [ -f "$FAKE_LOG.created" ] && echo '    "/Users/me/new one.keychain-db"'
    elif [ "$4" = "-s" ] || [ "$3" = "-s" ]; then
      rm -f "$FAKE_LOG.created"
    fi
    ;;
  create-keychain)
    for last; do :; done
    touch "$last" "$FAKE_LOG.created"
    ;;
  import) [ -z "$FAKE_FAIL_IMPORT" ] || exit 1 ;;
esac
exit 0
`,
  openssl: `${LOG}case "$1" in
  rand) echo fakepassword ;;
esac
exit 0
`,
};

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const [name, body] of Object.entries(TOOLS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}`, { mode: 0o755 });
  }
  const signDir = path.join(home, 'Library/Application Support/Quickaside/signing');
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  const run = (script, args = [], env = {}) => {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        FAKE_LOG: log,
        OPENSSL: path.join(bin, 'openssl'),
        ...env,
      },
    });
    return { ...r, calls: fs.readFileSync(log, 'utf8').trim().split('\n') };
  };
  const addIdentity = () => {
    fs.mkdirSync(signDir, { recursive: true });
    fs.writeFileSync(path.join(signDir, 'signing.keychain-db'), '');
    fs.writeFileSync(path.join(signDir, 'keychain-password'), 'secret\n');
  };
  return { run, addIdentity, signDir };
}

const adhoc = (calls) => calls.some((c) => c.startsWith('codesign') && c.includes('--sign - '));
const withIdentity = (calls) => calls.some((c) => c.startsWith('codesign') && c.includes(`--sign ${HASH}`));

test('signs ad-hoc and says how to stop the prompts when there is no identity', () => {
  const { run } = sandbox();
  const r = run(SIGN, ['/tmp/Fake.app']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(adhoc(r.calls));
  assert.ok(!r.calls.some((c) => c.startsWith('security')));
  assert.match(r.stdout, /create-signing-identity\.sh/);
});

test('signs with the local identity and its own keychain when it exists', () => {
  const { run, addIdentity, signDir } = sandbox();
  addIdentity();
  const r = run(SIGN, ['/tmp/Fake.app']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(withIdentity(r.calls));
  assert.ok(!adhoc(r.calls));
  assert.ok(r.calls.some((c) => c.includes(`--keychain ${signDir}/signing.keychain-db`)));
});

for (const [name, env] of [
  ['the keychain will not unlock', { FAKE_LOCKED: '1' }],
  ['the keychain has no identity', { FAKE_NO_IDENTITY: '1' }],
  ['codesign rejects the identity', { FAKE_FAIL_SIGN: HASH }],
]) {
  test(`falls back to ad-hoc when ${name}`, () => {
    const { run, addIdentity } = sandbox();
    addIdentity();
    const r = run(SIGN, ['/tmp/Fake.app'], env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(adhoc(r.calls));
    assert.match(r.stderr, /signing ad-hoc/);
  });
}

test('a failed ad-hoc signature fails the build', () => {
  const { run } = sandbox();
  const r = run(SIGN, ['/tmp/Fake.app'], { FAKE_FAIL_SIGN: '--sign -' });
  assert.notStrictEqual(r.status, 0);
});

test('creating the identity keeps the search list and leaves a private password file', () => {
  const { run, signDir } = sandbox();
  const r = run(CREATE);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.calls.includes('security list-keychains -d user -s /Users/me/Library/Keychains/login.keychain-db'));
  assert.ok(!r.calls.some((c) => c.includes('add-trusted-cert')));
  assert.ok(!r.calls.some((c) => c.includes('default-keychain')));
  assert.strictEqual(fs.statSync(path.join(signDir, 'keychain-password')).mode & 0o777, 0o600);
});

test('creating the identity does nothing when it already exists', () => {
  const { run, addIdentity } = sandbox();
  addIdentity();
  const r = run(CREATE);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already exists/);
  assert.ok(!r.calls.some((c) => c.startsWith('openssl') || c.includes('create-keychain')));
});

test('a failed import leaves nothing behind, so the next run starts clean', () => {
  const { run, signDir } = sandbox();
  const r = run(CREATE, [], { FAKE_FAIL_IMPORT: '1' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(signDir, 'signing.keychain-db')));
  assert.ok(!fs.existsSync(path.join(signDir, 'keychain-password')));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ClaudeSession, friendlyError } = require('../../src/main/claude');
const { Transcriber } = require('../../src/main/transcriber');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const FAKE_WCLI = path.join(__dirname, '..', 'fixtures', 'fake-whisper-cli.js');
fs.chmodSync(FAKE, 0o755);
fs.chmodSync(FAKE_WCLI, 0o755);

function makeSession(envExtra = {}, opts = {}) {
  const sent = [];
  const s = new ClaudeSession({
    resolveClaude: async () => (opts.missing ? null : FAKE),
    getEnv: async () => ({ ...process.env, ...envExtra }),
    getConfig: () => ({ model: 'sonnet', effort: 'low', systemPrompt: 'SYSTEM', folderAccess: false, folder: '' }),
    buildMessage: (item, { fresh }) => {
      sent.push({ id: item.id, fresh });
      return fresh ? `<transcript>\nX\n</transcript>\n<request>${item.request}</request>` : `<transcript_update>\n<request>${item.request}</request>`;
    },
    scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-')),
  });
  return { s, sent };
}

function waitDone(s, id) {
  return new Promise((resolve) => {
    const texts = [];
    const on = (ev) => {
      if (ev.id !== id) return;
      if (typeof ev.text === 'string' && !ev.done) texts.push(ev.text);
      if (ev.done) {
        s.off('answer', on);
        resolve({ ev, texts });
      }
    };
    s.on('answer', on);
  });
}

test('claude session streams answers and keeps one process across questions', async () => {
  const argsFile = path.join(os.tmpdir(), `cc-args-${process.pid}.jsonl`);
  const { s, sent } = makeSession({ FAKE_CLAUDE_ARGS_FILE: argsFile, FAKE_CLAUDE_DELAY: '30' });
  try {
    const p1 = waitDone(s, 1);
    s.ask({ id: 1, request: 'first' });
    const r1 = await p1;
    assert.strictEqual(r1.ev.text, 'Turn 1. fresh=true.');
    assert.ok(r1.texts.length >= 1, 'got streamed partial text');
    const p2 = waitDone(s, 2);
    s.ask({ id: 2, request: 'second' });
    const r2 = await p2;
    assert.strictEqual(r2.ev.text, 'Turn 2. fresh=false.');
    assert.deepStrictEqual(
      sent.map((x) => x.fresh),
      [true, false]
    );
    const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(JSON.parse).filter((a) => a.includes('-p'));
    assert.strictEqual(runs.length, 1, 'one process for both questions');
    const a = runs[0];
    for (const f of ['--input-format', '--include-partial-messages', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--system-prompt-file']) {
      assert.ok(a.includes(f), `missing ${f}`);
    }
    assert.strictEqual(a[a.indexOf('--tools') + 1], '');
    assert.strictEqual(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.strictEqual(s.status.version, '9.9.9');
  } finally {
    s.dispose();
    fs.rmSync(argsFile, { force: true });
  }
});

test('queued questions run in order; cancel restarts with full context', async () => {
  const { s, sent } = makeSession({ FAKE_CLAUDE_DELAY: '40' });
  try {
    const p1 = waitDone(s, 1);
    const p2 = waitDone(s, 2);
    s.ask({ id: 1, request: 'a' });
    s.ask({ id: 2, request: 'b' });
    await new Promise((r) => setTimeout(r, 150));
    s.cancel(1);
    const r1 = await p1;
    assert.ok(r1.ev.cancelled);
    const r2 = await p2;
    assert.strictEqual(r2.ev.text, 'Turn 1. fresh=true.', 'new process sees a fresh transcript');
    assert.deepStrictEqual(
      sent.map((x) => x.fresh),
      [true, true]
    );
  } finally {
    s.dispose();
  }
});

test('falls back to an inline system prompt on older Claude Code', async () => {
  const { s } = makeSession({ FAKE_CLAUDE_NO_FILE_FLAG: '1' });
  try {
    const p = waitDone(s, 1);
    s.ask({ id: 1, request: 'x' });
    const r = await p;
    assert.strictEqual(r.ev.text, 'Turn 1. fresh=true.');
    assert.ok(s.inlinePromptOnly);
  } finally {
    s.dispose();
  }
});

test('sign-in errors become a clear message; missing CLI is reported', async () => {
  const { s } = makeSession({ FAKE_CLAUDE_MODE: 'error' });
  try {
    const p = waitDone(s, 1);
    s.ask({ id: 1, request: 'x' });
    const r = await p;
    assert.match(r.ev.error, /not signed in/);
  } finally {
    s.dispose();
  }
  const m = makeSession({}, { missing: true });
  const p = waitDone(m.s, 7);
  m.s.ask({ id: 7, request: 'x' });
  const r = await p;
  assert.match(r.ev.error, /not installed/);
  assert.strictEqual(m.s.status.state, 'missing');
  assert.match(friendlyError('Error: rate limit exceeded'), /usage limit/);
});

test('transcriber falls back to whisper-cli, one run per segment, and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcli-'));
  const model = path.join(dir, 'ggml-test.bin');
  fs.writeFileSync(model, 'model');
  const argsFile = path.join(dir, 'args.jsonl');
  const t = new Transcriber({
    resolveBinaries: async () => ({ server: null, cli: FAKE_WCLI }),
    getEnv: async () => ({ ...process.env, FAKE_WCLI_ARGS: argsFile }),
  });
  const lines = [];
  t.on('line', (l) => lines.push(l));
  try {
    await t.start({ modelPath: model, language: 'en', threads: 2, prompt: 'Brightline, Cliniko' });
    assert.strictEqual(t.status.mode, 'cli');
    t.enqueue({ source: 'them', startMs: 0, endMs: 1000, speechMs: 900, samples: new Int16Array(16000) });
    t.enqueue({ source: 'you', startMs: 1500, endMs: 2500, speechMs: 900, samples: new Int16Array(16000) });
    await t.drain(10000);
    assert.deepStrictEqual(
      lines.map((l) => [l.source, l.text]),
      [
        ['them', 'Hello from whisper-cli.'],
        ['you', 'Hello from whisper-cli.'],
      ]
    );
    const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(runs.length, 2);
    const a = runs[0];
    assert.strictEqual(a[a.indexOf('-m') + 1], model);
    assert.strictEqual(a[a.indexOf('--prompt') + 1], 'Brightline, Cliniko');
    for (const f of ['-nt', '-np', '-sns', '-otxt']) assert.ok(a.includes(f), `missing ${f}`);
    const base = a[a.indexOf('-of') + 1];
    assert.ok(!fs.existsSync(`${base}.wav`) && !fs.existsSync(`${base}.txt`), 'temp files removed');
  } finally {
    await t.stop();
  }
});

test('transcriber posts WAV segments to a whisper-server compatible endpoint', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') return res.end('ok');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const i = body.indexOf('RIFF');
      seen.push({ rate: body.readUInt32LE(i + 24), bytes: body.readUInt32LE(i + 40), hasLang: body.includes('name="language"') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: seen.length === 1 ? ' Hello from the other side. ' : ' [BLANK_AUDIO]' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.CALLASIDE_WHISPER_URL = `http://127.0.0.1:${srv.address().port}`;
  const t = new Transcriber({ resolveBinaries: async () => ({}), getEnv: async () => process.env });
  const lines = [];
  t.on('line', (l) => lines.push(l));
  try {
    await t.start({ modelPath: '', language: 'en', threads: 2, prompt: 'Brightline' });
    t.enqueue({ source: 'them', startMs: 100, endMs: 1100, speechMs: 900, samples: new Int16Array(16000) });
    t.enqueue({ source: 'you', startMs: 200, endMs: 1200, speechMs: 900, samples: new Int16Array(8000) });
    await t.drain(5000);
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(seen[0], { rate: 16000, bytes: 32000, hasLang: true });
    assert.strictEqual(lines.length, 1, 'blank audio result is dropped');
    assert.strictEqual(lines[0].text, 'Hello from the other side.');
  } finally {
    delete process.env.CALLASIDE_WHISPER_URL;
    await t.stop();
    srv.close();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { TOOLS, callTool, OFF_MESSAGE, MAX_PAGE_CHARS } = require('../../src/connector/tools');
const { handle, VERSIONS, NAME } = require('../../src/connector/server');
const { Connector, serverConfig, bundleManifest, stageBundle } = require('../../src/main/connector');
const { defaults } = require('../../src/main/settings');

const SERVER = path.join(__dirname, '..', '..', 'src', 'connector', 'server.js');
const DAY = new Date('2026-10-20T10:00:00').getTime();

function line(id, source, text, startMs = id * 4000) {
  return { id, source, startMs, endMs: startMs + 3000, text };
}

const HARBOR = {
  id: 'c1',
  startedAt: DAY,
  endedAt: DAY + 30 * 60000,
  title: 'Harbor kickoff',
  project: 'Harbor Clinic',
  attendees: ['Dana Reed'],
  note: 'Ask about the budget',
  lines: [line(1, 'them', 'What would the pricing look like?'), line(2, 'you', 'It starts at nine thousand.')],
  qa: [{ question: 'What is our price?', answer: 'It starts at nine thousand.' }],
  notes: {
    summary: 'Dana asked about pricing.',
    decisions: ['Send a proposal'],
    actions: [
      { task: 'Send the proposal', owner: 'You' },
      { task: 'Share the budget', owner: 'Them' },
    ],
    followUp: 'Hi Dana, thanks for your time.',
  },
};

const NORTH = {
  id: 'c2',
  startedAt: DAY + 2 * 86400000,
  endedAt: DAY + 2 * 86400000 + 10 * 60000,
  title: 'Northwind check-in',
  project: 'Northwind',
  lines: [line(1, 'them', 'Can we move the launch?')],
  notes: { summary: 'They want to move the launch.', decisions: [], actions: [{ task: 'Move the launch date', owner: 'You' }], followUp: '' },
};

function library(records = [HARBOR, NORTH], settings = { connector: true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  fs.mkdirSync(path.join(dir, 'calls'));
  for (const r of records) fs.writeFileSync(path.join(dir, 'calls', `${r.id}.json`), JSON.stringify(r));
  return dir;
}

async function text(dir, name, args) {
  const result = await callTool(dir, name, args);
  assert.ok(!result.isError, result.content[0].text);
  return result.content[0].text;
}

async function data(dir, name, args) {
  return JSON.parse(await text(dir, name, args));
}

test('every tool only reads, and says so', () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name), ['search_calls', 'get_call', 'get_transcript', 'list_action_items', 'list_projects']);
  for (const t of TOOLS) {
    assert.strictEqual(t.annotations.readOnlyHint, true, t.name);
    assert.strictEqual(t.annotations.destructiveHint, false, t.name);
    assert.strictEqual(t.annotations.openWorldHint, false, t.name);
    assert.strictEqual(t.inputSchema.type, 'object', t.name);
  }
});

test('the connector is off until the user turns it on', async () => {
  assert.strictEqual(defaults().connector, false);
  for (const settings of [{ connector: false }, {}, { connector: 'true' }, null]) {
    const dir = library(undefined, settings);
    for (const t of TOOLS) {
      const result = await callTool(dir, t.name, { id: 'c1' });
      assert.strictEqual(result.isError, true, t.name);
      assert.strictEqual(result.content[0].text, OFF_MESSAGE);
    }
  }
  const broken = library();
  fs.writeFileSync(path.join(broken, 'settings.json'), '{ not json');
  assert.strictEqual((await callTool(broken, 'list_projects', {})).isError, true);
});

test('turning it off takes effect on the next request', async () => {
  const dir = library();
  await data(dir, 'list_projects', {});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ connector: false }));
  assert.strictEqual((await callTool(dir, 'list_projects', {})).isError, true);
});

test('search finds calls by word, project and date, newest first', async () => {
  const dir = library();
  const all = await data(dir, 'search_calls', {});
  assert.deepStrictEqual(all.calls.map((c) => c.id), ['c2', 'c1']);
  assert.strictEqual(all.total, 2);
  assert.strictEqual(all.calls[1].minutes, 30);
  assert.deepStrictEqual(all.calls[1].attendees, ['Dana Reed']);
  assert.match(all.calls[1].startedAt, /^2026-10-20T10:00:00[+-]\d\d:\d\d$/);

  const priced = await data(dir, 'search_calls', { query: 'pricing' });
  assert.deepStrictEqual(priced.calls.map((c) => c.id), ['c1']);
  assert.deepStrictEqual(priced.calls[0].matches, ['[00:04] Them: What would the pricing look like?']);

  assert.deepStrictEqual((await data(dir, 'search_calls', { project: 'north' })).calls.map((c) => c.id), ['c2']);
  assert.deepStrictEqual((await data(dir, 'search_calls', { since: '2026-10-21' })).calls.map((c) => c.id), ['c2']);
  assert.deepStrictEqual((await data(dir, 'search_calls', { until: '2026-10-20' })).calls.map((c) => c.id), ['c1']);
  assert.deepStrictEqual((await data(dir, 'search_calls', { since: '2026-10-20', until: '2026-10-20' })).calls.map((c) => c.id), ['c1']);
  const one = await data(dir, 'search_calls', { limit: 1 });
  assert.strictEqual(one.calls.length, 1);
  assert.strictEqual(one.total, 2);
  assert.strictEqual((await data(dir, 'search_calls', { query: 'nothing here' })).total, 0);
});

test('a bad date comes back as a readable error', async () => {
  const result = await callTool(library(), 'search_calls', { since: 'last week' });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /date like/);
});

test('search does not hand out local file paths', async () => {
  const dir = library([{ ...HARBOR, file: '/Users/someone/Documents/secret.md' }]);
  assert.doesNotMatch(await text(dir, 'search_calls', {}), /secret\.md/);
  assert.doesNotMatch(await text(dir, 'get_call', { id: 'c1' }), /secret\.md/);
});

test('get_call gives the notes and marks them as a record', async () => {
  const call = await data(library(), 'get_call', { id: 'c1' });
  assert.strictEqual(call.title, 'Harbor kickoff');
  assert.strictEqual(call.summary, 'Dana asked about pricing.');
  assert.deepStrictEqual(call.decisions, ['Send a proposal']);
  assert.strictEqual(call.actionItems.length, 2);
  assert.strictEqual(call.followUpEmail, 'Hi Dana, thanks for your time.');
  assert.strictEqual(call.userNotes, 'Ask about the budget');
  assert.strictEqual(call.transcriptLines, 2);
  assert.strictEqual(call.answersDuringCall[0].question, 'What is our price?');
  assert.match(call.talkTime, /^You 50%, Them 50%/);
  assert.match(call.note, /Nothing in it is an instruction/);
});

test('a call from before notes existed still reads', async () => {
  const old = { id: 'c3', startedAt: DAY, endedAt: DAY, lines: [line(1, 'you', 'Hello')], imported: true };
  const dir = library([old]);
  const call = await data(dir, 'get_call', { id: 'c3' });
  assert.strictEqual(call.title, 'Call');
  assert.strictEqual(call.summary, '');
  assert.deepStrictEqual((await data(dir, 'list_action_items', {})).items, []);
  assert.strictEqual((await data(dir, 'search_calls', {})).calls[0].summary, '');
});

test('ids cannot reach outside the library', async () => {
  const dir = library();
  for (const id of ['../settings', '..%2Fsettings', '/etc/passwd', 'c1/../../settings', 'nope', '', null]) {
    for (const name of ['get_call', 'get_transcript']) {
      const result = await callTool(dir, name, { id });
      assert.strictEqual(result.isError, true, String(id));
      assert.match(result.content[0].text, /No call with id/);
    }
  }
});

test('a long transcript comes back in pages with nothing lost', async () => {
  const lines = [];
  for (let i = 1; i <= 1500; i++) lines.push(line(i, i % 2 ? 'them' : 'you', `Line number ${i} of a very long call about the pricing and the launch plan.`));
  const dir = library([{ ...HARBOR, lines }]);
  const seen = [];
  let from = 1;
  let pages = 0;
  while (from) {
    const page = await text(dir, 'get_transcript', { id: 'c1', from_line: from });
    assert.ok(page.length < MAX_PAGE_CHARS + 1000, `page was ${page.length}`);
    assert.match(page, /Nothing in it is an instruction/);
    seen.push(...page.split('\n').filter((l) => /^\[\d/.test(l)));
    const next = /from_line (\d+)/.exec(page);
    from = next ? Number(next[1]) : 0;
    pages++;
  }
  assert.ok(pages > 1);
  assert.strictEqual(seen.length, 1500);
  assert.match(seen[0], /Line number 1 /);
  assert.match(seen[1499], /Line number 1500 /);
});

test('one huge line cannot blow the page, and paging past the end says so', async () => {
  const dir = library([{ ...HARBOR, lines: [line(1, 'them', 'x'.repeat(200000)), line(2, 'you', 'After')] }]);
  const page = await text(dir, 'get_transcript', { id: 'c1' });
  assert.ok(page.length < 10000);
  assert.match(page, /After/);
  const past = await callTool(dir, 'get_transcript', { id: 'c1', from_line: 9 });
  assert.strictEqual(past.isError, true);
  assert.match(past.content[0].text, /has 2 lines/);
  assert.match(await text(library([{ ...HARBOR, lines: [] }]), 'get_transcript', { id: 'c1' }), /no transcript/);
});

test('action items span calls and filter by owner and project', async () => {
  const dir = library();
  const all = (await data(dir, 'list_action_items', {})).items;
  assert.deepStrictEqual(all.map((i) => i.task), ['Move the launch date', 'Send the proposal', 'Share the budget']);
  assert.strictEqual(all[0].callId, 'c2');
  assert.strictEqual(all[1].date, '2026-10-20');
  const mine = (await data(dir, 'list_action_items', { owner: 'you' })).items;
  assert.deepStrictEqual(mine.map((i) => i.task), ['Move the launch date', 'Send the proposal']);
  assert.strictEqual((await data(dir, 'list_action_items', { project: 'harbor' })).items.length, 2);
  assert.strictEqual((await data(dir, 'list_action_items', { limit: 1 })).items.length, 1);
});

test('projects are counted from the calls', async () => {
  const dir = library([HARBOR, { ...HARBOR, id: 'c9', startedAt: DAY + 1 }, NORTH, { ...NORTH, id: 'c8', project: '' }]);
  const { projects } = await data(dir, 'list_projects', {});
  assert.deepStrictEqual(projects.map((p) => [p.project, p.calls]).sort(), [['(no project)', 1], ['Harbor Clinic', 2], ['Northwind', 1]]);
});

test('an empty or missing library is not an error', async () => {
  const dir = library([]);
  fs.rmSync(path.join(dir, 'calls'), { recursive: true });
  assert.strictEqual((await data(dir, 'search_calls', {})).total, 0);
  assert.deepStrictEqual((await data(dir, 'list_projects', {})).projects, []);
});

test('no tool writes to the data folder', async () => {
  const dir = library();
  const snapshot = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return `${f}:${stat.size}:${stat.mtimeMs}`;
  });
  const before = snapshot();
  for (const t of TOOLS) await callTool(dir, t.name, { id: 'c1', query: 'pricing' });
  assert.deepStrictEqual(snapshot(), before);
});

test('protocol: initialize keeps a known version and offers one for an unknown', async () => {
  const dir = library();
  const known = await handle(dir, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(known.result.protocolVersion, '2025-06-18');
  assert.deepStrictEqual(known.result.capabilities, { tools: {} });
  assert.strictEqual(known.result.serverInfo.name, NAME);
  assert.match(known.result.instructions, /tell the user instead/);
  const unknown = await handle(dir, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.strictEqual(unknown.result.protocolVersion, VERSIONS[0]);
});

test('protocol: bad calls get the right errors', async () => {
  const dir = library();
  const call = (name) => handle(dir, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } });
  for (const name of ['delete_call', 'constructor', '__proto__', 'toString', undefined]) {
    assert.strictEqual((await call(name)).error.code, -32602, String(name));
  }
  assert.strictEqual((await handle(dir, { jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code, -32601);
  assert.strictEqual((await handle(dir, { id: 5, method: 'ping' })).error.code, -32600);
  assert.strictEqual((await handle(dir, 'hello')).error.code, -32600);
  assert.strictEqual(await handle(dir, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual(await handle(dir, { jsonrpc: '2.0', id: 6, result: {} }), null);
  assert.deepStrictEqual((await handle(dir, { jsonrpc: '2.0', id: 7, method: 'ping' })).result, {});
  const batch = await handle(dir, [{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]);
  assert.deepStrictEqual(batch.map((r) => r.id), [8]);
});

function exchange(script, dir, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--data', dir], { stdio: 'pipe' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, err, replies: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
    child.stdin.end(messages.join('\n') + '\n');
  });
}

const SESSION = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_calls', arguments: { query: 'pricing' } } }),
];

test('over real stdio: it answers line by line, survives junk and stops when stdin closes', async () => {
  const { code, err, replies } = await exchange(SERVER, library(), ['not json', ...SESSION]);
  assert.strictEqual(code, 0);
  assert.strictEqual(err, '');
  const byId = new Map(replies.map((r) => [r.id, r]));
  assert.strictEqual(byId.get(null).error.code, -32700);
  assert.strictEqual(byId.get(1).result.serverInfo.name, NAME);
  assert.strictEqual(byId.get(2).result.tools.length, TOOLS.length);
  assert.match(byId.get(3).result.content[0].text, /Harbor kickoff/);
  assert.strictEqual(replies.length, 4); // the notification got no reply
});

test('the bundle for Claude Desktop runs on its own', async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const dir = library();
  stageBundle(stage, { version: '1.2.3', dataDir: dir });
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest, bundleManifest({ version: '1.2.3', dataDir: dir }));
  assert.ok(fs.statSync(path.join(stage, manifest.icon)).size > 0, 'the bundle carries its icon');
  assert.strictEqual(manifest.name, NAME);
  assert.doesNotMatch(manifest.display_name, /claude|anthropic/i);
  assert.deepStrictEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepStrictEqual(manifest.server.mcp_config.args.slice(1), ['--data', dir]);
  assert.ok(fs.existsSync(path.join(stage, manifest.server.entry_point)));
  const script = manifest.server.mcp_config.args[0].replace('${__dirname}', stage);
  const { code, replies } = await exchange(script, dir, SESSION);
  assert.strictEqual(code, 0);
  assert.strictEqual(replies.find((r) => r.id === 1).result.serverInfo.version, '1.2.3');
  assert.match(replies.find((r) => r.id === 3).result.content[0].text, /Harbor kickoff/);
});

test('Claude Code starts the server through the app, never as plain Node', () => {
  const command = '/Apps/Quickaside.app/Contents/MacOS/Quickaside';
  const built = serverConfig({ execPath: command, appPath: '/Apps/res/app', packaged: true, dataDir: '/data dir' });
  assert.strictEqual(built.command, command);
  assert.deepStrictEqual(built.args, ['--connector', '--data', '/data dir']);
  assert.strictEqual(built.env, undefined);
  const dev = serverConfig({ execPath: '/repo/Electron', appPath: '/repo', packaged: false, dataDir: '/d' });
  assert.deepStrictEqual(dev.args, ['/repo', '--connector', '--data', '/d']);
});

// A stand-in for `claude` that writes down what it was asked.
function fakeClaude(dir, getOutput, getCode = 0) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> "${dir}/calls.log"\ncase "$2" in\n  get) printf '%b' '${getOutput.replace(/\n/g, '\\n')}'; exit ${getCode};;\n  add-json) [ -f "${dir}/refuse" ] && { echo 'no thanks' >&2; exit 1; }; exit 0;;\n  remove) exit 0;;\nesac\n`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function connectorWith(dir, bin) {
  return new Connector({
    resolveClaude: async () => bin,
    getEnv: async () => process.env,
    execPath: '/Apps/Electron',
    appPath: '/Apps/app',
    dataDir: dir,
    version: '1.0.0',
  });
}

test('Claude Code status reads what is set up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-'));
  assert.strictEqual(await connectorWith(dir, null).claudeCodeStatus(), 'missing');
  assert.strictEqual(await connectorWith(dir, fakeClaude(dir, 'nothing', 1)).claudeCodeStatus(), 'off');
  const output = (status, bin, args = '--connector --data /d') => `  Status: ${status}\n  Command: ${bin}\n  Args: ${args}\n`;
  assert.strictEqual(await connectorWith(dir, fakeClaude(dir, output('✔ Connected', '/Apps/Electron'))).claudeCodeStatus(), 'connected');
  assert.strictEqual(await connectorWith(dir, fakeClaude(dir, output('✘ Failed to connect', '/Apps/Electron'))).claudeCodeStatus(), 'failed');
  assert.strictEqual(await connectorWith(dir, fakeClaude(dir, output('✔ Connected', '/Old/Electron'))).claudeCodeStatus(), 'moved');
  // Set up before plain Node was turned off, so it can only fail until it is set up again.
  assert.strictEqual(await connectorWith(dir, fakeClaude(dir, output('✘ Failed to connect', '/Apps/Electron', '/Apps/app/src/connector/server.js --data /d'))).claudeCodeStatus(), 'moved');
});

test('the .mcpb has no folder entries, because the unpacker fails on them', { skip: !fs.existsSync('/usr/bin/zip') }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = await connectorWith(dir, null).buildBundle();
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', file]).toString().trim().split('\n');
  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes('server/src/connector/server.js'));
  assert.deepStrictEqual(entries.filter((e) => e.endsWith('/')), []);
  await connectorWith(dir, null).buildBundle(); // building again replaces it
  assert.strictEqual(execFileSync('/usr/bin/unzip', ['-Z1', file]).toString().trim().split('\n').length, entries.length);
});

test('connecting replaces any old entry at user scope, and errors reach the user', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-'));
  const c = connectorWith(dir, fakeClaude(dir, ''));
  await c.connectClaudeCode();
  const asked = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
  assert.strictEqual(asked[0], `mcp remove ${NAME} --scope user`);
  assert.match(asked[1], new RegExp(`^mcp add-json ${NAME} \\{.*\\} --scope user$`));
  assert.deepStrictEqual(JSON.parse(/\{.*\}/.exec(asked[1])[0]).args.slice(-3, -2), ['--connector']);
  fs.writeFileSync(path.join(dir, 'refuse'), '');
  await assert.rejects(c.connectClaudeCode(), /no thanks/);
  await c.disconnectClaudeCode();
  await assert.rejects(connectorWith(dir, null).connectClaudeCode(), /not found/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CallDetector, callAppName } = require('../../src/main/call-detector');
const { looksLikeQuestion, TranscriptStore } = require('../../src/main/transcript');
const { buildDraft, parseDraft, cleanTerms, cleanSuggestions } = require('../../src/main/assist');
const { summarizeEntries, parseStatLine, budgetFor } = require('../../src/main/knowledge');
const { buildSystemPrompt } = require('../../src/main/prompts');
const { readPaths, grepPaths } = require('../../src/main/claude');
const { Settings } = require('../../src/main/settings');
const { isInside } = require('../../src/main/paths');
const { toMarkdown } = require('../../src/main/transcript');
const { Log, clean } = require('../../src/main/log');
const { Updater, repoFromIssues } = require('../../src/main/updater');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const crypto = require('node:crypto');
const { downloadModel } = require('../../src/main/models');
const { CallStore, talkStats, parseMarkdownCall, statsLine } = require('../../src/main/calls');
const { buildNotes, parseNotes, notesToMarkdown, templateOf } = require('../../src/main/notes');
const { pickEvent, matchProject } = require('../../src/main/calendar');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- call detection ----------

test('call apps are named, and helper processes count as their app', () => {
  assert.strictEqual(callAppName(['us.zoom.xos']), 'Zoom');
  assert.strictEqual(callAppName(['com.google.Chrome.helper']), 'Chrome');
  assert.strictEqual(callAppName(['com.tinyspeck.slackmacgap.helper']), 'Slack');
  assert.strictEqual(callAppName(['com.apple.WebKit.GPU']), 'Safari');
});

test('a dedicated call app wins over a browser', () => {
  assert.strictEqual(callAppName(['com.google.Chrome.helper', 'us.zoom.xos']), 'Zoom');
});

test('dictation and this app do not count as calls', () => {
  assert.strictEqual(callAppName(['com.apple.SpeechRecognitionCore.speechrecognitiond']), null);
  assert.strictEqual(callAppName(['/usr/bin/some-tool']), null);
  assert.strictEqual(callAppName(['io.github.aalishanjami.quickaside']), null);
  assert.strictEqual(callAppName(['com.github.Electron.helper']), null);
  assert.strictEqual(callAppName([]), null);
});

function detector(events) {
  const d = new CallDetector({ resolveBinary: () => null, holdMs: 20, endMs: 30 });
  d.on('call', (e) => events.push(`call:${e.name}`));
  d.on('ended', () => events.push('ended'));
  return d;
}

test('a call counts once the mic stays open, and ends once it stays closed', async () => {
  const events = [];
  const d = detector(events);
  d.update(['us.zoom.xos']);
  assert.deepStrictEqual(events, []);
  await wait(40);
  assert.deepStrictEqual(events, ['call:Zoom']);
  d.update([]);
  assert.deepStrictEqual(events, ['call:Zoom']);
  await wait(50);
  assert.deepStrictEqual(events, ['call:Zoom', 'ended']);
  assert.strictEqual(d.current, null);
});

test('a quick mic test raises nothing', async () => {
  const events = [];
  const d = detector(events);
  d.update(['us.zoom.xos']);
  d.update([]);
  await wait(50);
  assert.deepStrictEqual(events, []);
});

test('a short mic gap does not end the call', async () => {
  const events = [];
  const d = detector(events);
  d.update(['us.zoom.xos']);
  await wait(40);
  d.update([]);
  await wait(10);
  d.update(['us.zoom.xos']);
  await wait(50);
  assert.deepStrictEqual(events, ['call:Zoom']);
});

test('stopping the detector ends a call it was tracking', async () => {
  const events = [];
  const d = detector(events);
  d.update(['us.zoom.xos']);
  await wait(40);
  d.stop();
  assert.deepStrictEqual(events, ['call:Zoom', 'ended']);
});

test('the detector reports missing when there is no helper', async () => {
  const d = new CallDetector({ resolveBinary: () => null });
  await d.start();
  assert.strictEqual(d.state, 'missing');
});

test('the detector reads the helper output, including split lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-'));
  const bin = path.join(dir, 'fake');
  fs.writeFileSync(bin, `#!/bin/bash\nprintf '["us.zo'\nsleep 0.05\nprintf 'om.xos"]\\n'\nsleep 2\n`, { mode: 0o755 });
  const d = new CallDetector({ resolveBinary: () => bin, holdMs: 10 });
  const seen = new Promise((resolve) => d.once('call', resolve));
  await d.start();
  assert.strictEqual(d.state, 'on');
  assert.deepStrictEqual(await seen, { name: 'Zoom' });
  d.stop();
  assert.strictEqual(d.state, 'off');
});

// ---------- questions ----------

test('questions are found with or without the question mark', () => {
  for (const q of [
    'What does it cost?',
    'How much is it? We have a budget.',
    'so how much does that cost',
    'can you walk me through the pricing',
    'Do you work with clinics like ours',
    'Okay, what would a pilot look like',
    "I'd love to hear how onboarding works",
    'Tell me about your team.',
  ]) {
    assert.ok(looksLikeQuestion(q), q);
  }
});

test('plain statements are not questions', () => {
  for (const s of ['What we do is integrate your tools.', 'That sounds good to me.', 'We have a budget for this.', 'How nice.', 'Okay.', '']) {
    assert.ok(!looksLikeQuestion(s), s);
  }
});

test('the last question from them is found without a question mark', () => {
  const store = new TranscriptStore();
  store.add({ source: 'them', startMs: 0, endMs: 1000, text: 'walk me through the pricing' });
  store.add({ source: 'them', startMs: 2000, endMs: 3000, text: 'That makes sense.' });
  assert.strictEqual(store.lastQuestionFromThem().text, 'walk me through the pricing');
});

// ---------- drafts ----------

test('a draft asks only for the fields requested and sends what is known', () => {
  const { system, prompt } = buildDraft({
    fields: ['aboutMe'],
    current: { aboutMe: 'I run Brightline.', vocabulary: 'Brightline' },
    contextDocs: [{ name: 'a.md', text: 'hello' }],
    folder: '/notes',
  });
  assert.match(prompt, /"aboutMe"/);
  assert.doesNotMatch(prompt, /"offer"/);
  assert.match(prompt, /I run Brightline/);
  assert.match(prompt, /hello/);
  assert.match(system, /\/notes/);
  assert.match(system, /Never invent/);
});

test('a draft without a folder never mentions tools', () => {
  const { system } = buildDraft({ fields: ['aboutMe'], current: {}, contextDocs: [], folder: null });
  assert.doesNotMatch(system, /Glob/);
});

test('parsing a draft copes with code fences and drops unasked keys', () => {
  const out = parseDraft('```json\n{"aboutMe":" Hi ","offer":"x"}\n```', ['aboutMe']);
  assert.deepStrictEqual(out, { aboutMe: 'Hi' });
});

test('parsing a bad draft gives a plain error', () => {
  assert.throws(() => parseDraft('Sorry, I could not', ['aboutMe']), /did not return a draft/);
  assert.throws(() => parseDraft('{broken}', ['aboutMe']), /did not return a draft/);
});

test('terms are cleaned, deduplicated and capped', () => {
  assert.deepStrictEqual(cleanTerms(['Brightline', 'brightline', ' Hub, Spot ', '', 'x'.repeat(41)]), ['Brightline', 'Hub Spot']);
  assert.strictEqual(cleanTerms(Array.from({ length: 60 }, (_, i) => `t${i}`)).length, 40);
  assert.deepStrictEqual(cleanTerms('not a list'), []);
});

test('the knowledge draft returns a summary and topics', () => {
  const out = parseDraft('{"knowledge":{"summary":"Proposals.","topics":["Pricing","Pricing"]}}', ['knowledge']);
  assert.deepStrictEqual(out.knowledge, { summary: 'Proposals.', topics: ['Pricing'] });
});

test('what you offer and who you talk to reach the system prompt', () => {
  const p = buildSystemPrompt({ aboutMe: 'I am Sam.', offer: 'AI integrations', audience: 'Clinic owners' });
  assert.match(p, /<about_user>[\s\S]*I am Sam[\s\S]*AI integrations[\s\S]*Clinic owners[\s\S]*<\/about_user>/);
});

// ---------- sources and knowledge ----------

test('only files opened with Read count as sources', () => {
  const message = {
    content: [
      { type: 'text', text: 'x' },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'price' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/notes/pricing.md' } },
    ],
  };
  assert.deepStrictEqual(readPaths(message), ['/notes/pricing.md']);
  assert.deepStrictEqual(readPaths(null), []);
});

test('a content search credits matched files, not the lines around them', () => {
  const content = 'services/pricing.md-1-# Pricing\nservices/pricing.md:2:Pilot: $4,500\nnotes.md-3-context only\nmy file.md:9:Pilot again';
  assert.deepStrictEqual(grepPaths({ mode: 'content', content }), ['services/pricing.md', 'my file.md']);
});

test('other search results credit nothing', () => {
  assert.deepStrictEqual(grepPaths({ mode: 'files_with_matches', filenames: ['a.md'] }), []);
  assert.deepStrictEqual(grepPaths(null), []);
  assert.deepStrictEqual(grepPaths('text'), []);
});

test('a broad search stops at three files', () => {
  const content = ['a.md:1:x', 'b.md:1:x', 'c.md:1:x', 'd.md:1:x'].join('\n');
  assert.strictEqual(grepPaths({ mode: 'content', content }).length, 3);
});

test('the folder overview counts files, folders and recent edits', () => {
  const now = Date.UTC(2026, 10, 5);
  const day = 86400000;
  const s = summarizeEntries(
    [
      { file: 'clients/acme/notes.md', mtimeMs: now - day, size: 10 },
      { file: 'clients/beta.md', mtimeMs: now - 30 * day, size: 10 },
      { file: 'pricing.pdf', mtimeMs: now - 2 * day, size: 10 },
    ],
    now
  );
  assert.strictEqual(s.files, 3);
  assert.strictEqual(s.folders, 2);
  assert.strictEqual(s.recent, 2);
  assert.strictEqual(s.latest.name, 'notes.md');
  assert.deepStrictEqual(s.top[0], { name: 'clients', count: 2 });
  assert.deepStrictEqual(s.top[1], { name: 'Top level', count: 1 });
  assert.deepStrictEqual(s.types[0], { name: 'md', count: 2 });
});

test('an empty folder gives an empty overview', () => {
  const s = summarizeEntries([]);
  assert.strictEqual(s.files, 0);
  assert.strictEqual(s.latest, null);
});

test('stat lines keep tabs and spaces in file names', () => {
  assert.deepStrictEqual(parseStatLine('1700000000\t12\t/notes/my file.md', '/notes'), { mtimeMs: 1700000000000, size: 12, file: 'my file.md' });
  assert.strictEqual(parseStatLine('1\t2\t/elsewhere/x', '/notes'), null);
});

test('the file budget says which files are cut or left out', () => {
  const b = budgetFor([
    { file: '/a.md', size: 1000 },
    { file: '/big.md', size: 90000 },
    { file: '/gone.md', size: null },
    { file: '/c.md', size: 40000 },
    { file: '/d.md', size: 40000 },
    { file: '/e.md', size: 40000 },
    { file: '/f.md', size: 10 },
  ]);
  assert.deepStrictEqual(
    b.files.map((f) => f.state),
    ['ok', 'cut', 'missing', 'ok', 'left-out', 'left-out', 'left-out']
  );
  assert.strictEqual(b.used, 81000);
  assert.strictEqual(b.limit, 120000);
});

// ---------- projects ----------

const harbor = { name: 'Harbor Clinic', brief: 'Pilot scoped, not started.', folder: '/notes/clients/harbor' };

test('a project reaches the prompt with a rule against other clients', () => {
  const p = buildSystemPrompt({ project: harbor, folderAccess: true, contextFolder: '/notes' });
  assert.match(p, /<project name="Harbor Clinic">\nPilot scoped, not started\.\n<\/project>/);
  assert.match(p, /Facts about other clients or projects do not apply/);
  assert.match(p, /must be backed by <project>/);
});

test('a project folder is searched before the rest of the notes', () => {
  const p = buildSystemPrompt({ project: harbor, folderAccess: true, contextFolder: '/notes' });
  assert.match(p, /Look in \/notes\/clients\/harbor first, and search the rest only if/);
});

test('a project with no folder searches only as a last resort', () => {
  const p = buildSystemPrompt({ project: { ...harbor, folder: null }, folderAccess: true, contextFolder: '/notes' });
  assert.match(p, /Search only when <project> and <context_files> do not answer it/);
});

test('with no project the prompt is unchanged', () => {
  const p = buildSystemPrompt({ folderAccess: true, contextFolder: '/notes' });
  assert.doesNotMatch(p, /<project/);
  assert.doesNotMatch(p, /other clients/);
  assert.match(p, /must be backed by <about_user>, <context_files>, the user's notes or the transcript/);
});

test('a note for the call reaches the prompt, and an empty one does not', () => {
  assert.match(buildSystemPrompt({ callNote: 'Worried about price' }), /<call_note>\nWorried about price\n<\/call_note>/);
  assert.doesNotMatch(buildSystemPrompt({ callNote: '  ' }), /call_note/);
});

test('a quote in a project name cannot break out of the prompt tag', () => {
  const p = buildSystemPrompt({ project: { name: 'A"B', brief: '', folder: null } });
  assert.match(p, /<project name="A'B">/);
  assert.match(p, /\(no brief yet\)/);
});

test('projects are cleaned when saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const s = new Settings(dir);
  s.update({
    projects: [{ id: 'a', name: 'Acme', brief: 'x', folder: '/n/a', files: ['/f.md', 3, ' '], extra: 1 }, { name: 'no id' }, 'nonsense'],
    activeProject: 'a',
  });
  assert.deepStrictEqual(s.get().projects, [{ id: 'a', name: 'Acme', brief: 'x', folder: '/n/a', files: ['/f.md'], template: '' }]);
  assert.strictEqual(new Settings(dir).get().activeProject, 'a');
});

test('project folders must sit below the notes folder', () => {
  assert.ok(isInside('/notes', '/notes/clients/acme'));
  assert.ok(!isInside('/notes', '/notes'));
  assert.ok(!isInside('/notes', '/notes-old/acme'));
  assert.ok(!isInside('/notes', '/notes/../secret'));
  assert.ok(!isInside('/notes', '/etc'));
});

test('a project brief draft sends the project and starts in its folder', () => {
  const { system, prompt } = buildDraft({ fields: ['projectBrief'], current: {}, contextDocs: [], folder: '/notes', project: { ...harbor, brief: 'old' } });
  assert.match(prompt, /<project name="Harbor Clinic">\nold\n<\/project>/);
  assert.match(system, /look in \/notes\/clients\/harbor first/);
});

test('a project left blank is gone at the next launch, and real ones stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const blank = { id: 'a', name: '', brief: '  ', folder: '', files: [] };
  const named = { id: 'b', name: 'Harbor', brief: '', folder: '', files: [] };
  const briefOnly = { id: 'c', name: '', brief: 'Dental client', folder: '', files: [] };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ projects: [blank, named, briefOnly] }));
  assert.deepStrictEqual(new Settings(dir).get().projects.map((p) => p.id), ['b', 'c']);
});

test('suggesting projects skips the ones that exist', () => {
  const { prompt } = buildDraft({ fields: ['projects'], current: { projects: [{ name: 'Acme' }] }, contextDocs: [], folder: '/notes' });
  assert.match(prompt, /<existing_projects>\nAcme\n<\/existing_projects>/);
});

test('suggestions are cleaned, deduplicated and capped', () => {
  assert.deepStrictEqual(cleanSuggestions([{ name: ' Acme ', brief: ' b ', folder: 'a' }, { name: 'acme' }, { brief: 'no name' }, null]), [{ name: 'Acme', brief: 'b', folder: 'a' }]);
  assert.strictEqual(cleanSuggestions(Array.from({ length: 12 }, (_, i) => ({ name: `p${i}` }))).length, 8);
  assert.deepStrictEqual(cleanSuggestions('nope'), []);
});

test('the saved call says which project and note it used', () => {
  const md = toMarkdown({ startedAt: Date.now(), endedAt: Date.now(), lines: [], qa: [], project: 'Harbor Clinic', note: 'Worried about price' });
  assert.match(md, /Project: Harbor Clinic/);
  assert.match(md, /Note: Worried about price/);
  assert.doesNotMatch(toMarkdown({ startedAt: Date.now(), endedAt: Date.now(), lines: [], qa: [] }), /Project:/);
});

// ---------- logs ----------

function freshLog(opts) {
  return new Log(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), opts);
}

test('a log line keeps the event and its fields', () => {
  const log = freshLog();
  log.info('call.start', { app: 'Zoom', project: false, skipped: undefined });
  assert.match(log.tail(), /^\S+ INFO call\.start app=Zoom project=false$/);
});

test('log values lose the home folder, line breaks and length', () => {
  assert.strictEqual(clean(`${os.homedir()}/notes/a.md`), '~/notes/a.md');
  assert.strictEqual(clean('one\ntwo'), 'one two');
  assert.strictEqual(clean('x'.repeat(500)).length, 200);
  assert.strictEqual(clean(new Error('boom')), 'boom');
});

test('the log rotates and keeps the previous file for reports', () => {
  const log = freshLog({ maxBytes: 200 });
  for (let i = 0; i < 12; i++) log.info('tick', { i });
  assert.ok(fs.statSync(log.file).size <= 200);
  assert.ok(fs.existsSync(log.old));
  assert.strictEqual(log.tail(3).split('\n').length, 3);
  assert.match(log.tail(1), /i=11/);
});

test('a log that cannot be written does not throw', () => {
  const log = new Log('/nonexistent/place/that/cannot/exist');
  assert.doesNotThrow(() => log.warn('x'));
  assert.strictEqual(log.tail(), '');
});

test('new installs do not hide from screen sharing', () => {
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')));
  assert.strictEqual(s.get().hideFromScreenShare, false);
  assert.strictEqual(s.get().consentReminder, true);
});

test('the theme only takes known values', () => {
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')));
  s.update({ theme: 'dark' });
  s.update({ theme: 'neon' });
  assert.strictEqual(s.get().theme, 'dark');
});

// ---------- updates ----------

function fakeUpdater({ busy = false, enabled = true } = {}) {
  const auto = new EventEmitter();
  auto.calls = [];
  auto.setFeedURL = ({ url }) => auto.calls.push(url);
  auto.checkForUpdates = () => auto.calls.push('check');
  auto.quitAndInstall = () => auto.calls.push('install');
  const state = { busy };
  const u = new Updater({ autoUpdater: auto, repo: 'a/b', version: '1.2.3', enabled, isBusy: () => state.busy, log: { info() {}, warn() {} }, firstCheckMs: 1e7, checkEveryMs: 1e7 });
  return { u, auto, state };
}

test('the update address comes from the repo and version', () => {
  const { u, auto } = fakeUpdater();
  u.start();
  u.stop();
  assert.deepStrictEqual(auto.calls, ['https://update.electronjs.org/a/b/darwin-arm64/1.2.3']);
  assert.strictEqual(repoFromIssues('https://github.com/aalishanjami/quickaside/issues'), 'aalishanjami/quickaside');
});

test('a build that cannot update stays off', () => {
  const { u, auto } = fakeUpdater({ enabled: false });
  u.start();
  assert.strictEqual(u.state, 'off');
  assert.deepStrictEqual(auto.calls, []);
});

test('updates are not even checked during a call', () => {
  const { u, auto, state } = fakeUpdater({ busy: true });
  u.start();
  u.stop();
  assert.strictEqual(u.check(), false);
  assert.ok(!auto.calls.includes('check'));
  state.busy = false;
  assert.strictEqual(u.check(), true);
  assert.ok(auto.calls.includes('check'));
});

test('a ready update never installs during a call', () => {
  const { u, auto, state } = fakeUpdater();
  u.start();
  u.stop();
  auto.emit('update-downloaded');
  assert.strictEqual(u.state, 'ready');
  state.busy = true;
  let prepared = false;
  assert.strictEqual(u.install(() => (prepared = true)), false);
  assert.strictEqual(prepared, false);
  assert.ok(!auto.calls.includes('install'));
  state.busy = false;
  assert.strictEqual(u.install(() => (prepared = true)), true);
  assert.strictEqual(prepared, true);
  assert.ok(auto.calls.includes('install'));
});

test('a failed install asks to relaunch, and a failed check does not', () => {
  const { u, auto } = fakeUpdater();
  let relaunches = 0;
  u.on('install-failed', () => relaunches++);
  u.start();
  u.stop();
  auto.emit('error', new Error('offline'));
  assert.strictEqual(relaunches, 0);
  assert.strictEqual(u.state, 'idle');
  auto.emit('update-downloaded');
  u.install(() => {});
  auto.emit('error', new Error('could not replace the app'));
  assert.strictEqual(relaunches, 1);
});

// ---------- first run and downloads ----------

test('a new install shows setup, and a Mac already set up does not', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  assert.strictEqual(new Settings(fresh).get().setupDone, false);
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  fs.writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ aboutMe: 'x' }));
  assert.strictEqual(new Settings(old).get().setupDone, true);
});

function modelServer(body, { cutAt, noRange } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    seen.push(req.headers.range || 'full');
    const from = range && !noRange ? Number(range[1]) : 0;
    res.writeHead(from ? 206 : 200, { 'content-length': body.length - from });
    if (cutAt && !from) {
      res.write(body.subarray(0, cutAt));
      return setTimeout(() => res.destroy(), 20);
    }
    res.end(body.subarray(from));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` })));
}

const blob = crypto.randomBytes(200000);
const model = (sha256) => [{ id: 'm', file: 'm.bin', sha256 }];
const good = crypto.createHash('sha256').update(blob).digest('hex');

test('a dropped download carries on from where it stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  const { server, seen, url } = await modelServer(blob, { cutAt: 90000 });
  await assert.rejects(downloadModel(dir, 'm', null, undefined, { baseUrl: url, models: model(good) }));
  assert.ok(fs.statSync(path.join(dir, 'm.bin.part')).size >= 90000);
  await downloadModel(dir, 'm', null, undefined, { baseUrl: url, models: model(good) });
  server.close();
  assert.ok(seen[1].startsWith('bytes=9'), seen[1]);
  assert.ok(fs.readFileSync(path.join(dir, 'm.bin')).equals(blob));
  assert.ok(!fs.existsSync(path.join(dir, 'm.bin.part')));
});

test('a server that cannot resume starts the file again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  fs.writeFileSync(path.join(dir, 'm.bin.part'), 'stale bytes');
  const { server, url } = await modelServer(blob, { noRange: true });
  await downloadModel(dir, 'm', null, undefined, { baseUrl: url, models: model(good) });
  server.close();
  assert.ok(fs.readFileSync(path.join(dir, 'm.bin')).equals(blob));
});

test('a damaged download is thrown away, never installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  const { server, url } = await modelServer(blob);
  await assert.rejects(downloadModel(dir, 'm', null, undefined, { baseUrl: url, models: model('0'.repeat(64)) }), /damaged/);
  server.close();
  assert.ok(!fs.existsSync(path.join(dir, 'm.bin')));
  assert.ok(!fs.existsSync(path.join(dir, 'm.bin.part')));
});

// ---------- talk time ----------

const say = (source, startMs, endMs, text = 'hello there') => ({ source, startMs, endMs, text });

test('talk time counts each side, turns and the longest stretch', () => {
  const s = talkStats([say('you', 0, 1000), say('them', 1000, 4000), say('them', 4000, 7000, 'How much does it cost?'), say('you', 7000, 8000)]);
  assert.strictEqual(s.youMs, 2000);
  assert.strictEqual(s.themMs, 6000);
  assert.strictEqual(s.youShare, 25);
  assert.strictEqual(s.themShare, 75);
  assert.strictEqual(s.turns, 3);
  assert.deepStrictEqual(s.longest, { who: 'them', ms: 6000 });
  assert.strictEqual(s.theirQuestions, 1);
});

test('lines out of order still make the right turns', () => {
  assert.strictEqual(talkStats([say('them', 5000, 6000), say('you', 0, 1000), say('them', 2000, 3000)]).turns, 2);
});

test('an empty call has no talk time', () => {
  const s = talkStats([]);
  assert.strictEqual(s.turns, 0);
  assert.strictEqual(s.longest, null);
  assert.strictEqual(statsLine(s), '');
});

// ---------- the library ----------

function freshCalls() {
  return new CallStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calls-')), 'calls'));
}

test('saving again keeps notes written since', () => {
  const c = freshCalls();
  c.upsert('c1', { startedAt: 1, lines: [] });
  c.upsert('c1', { notes: { summary: 'Done.' } });
  c.upsert('c1', { lines: [say('you', 0, 1)] });
  assert.strictEqual(c.get('c1').notes.summary, 'Done.');
  assert.strictEqual(c.get('c1').lines.length, 1);
});

test('the list is newest first and titled as well as it can be', async () => {
  const c = freshCalls();
  c.upsert('old', { startedAt: 1, app: 'Zoom' });
  c.upsert('new', { startedAt: 2, title: 'Intro with Priya', app: 'Zoom' });
  const list = await c.list();
  assert.deepStrictEqual(list.map((x) => x.title), ['Intro with Priya', 'Zoom']);
});

test('search needs every word, and looks in the transcript, answers and notes', async () => {
  const c = freshCalls();
  c.upsert('a', { startedAt: 1, lines: [say('them', 0, 1, 'our budget is tight')] });
  c.upsert('b', { startedAt: 2, qa: [{ question: 'q', answer: 'The pilot costs $4,500' }] });
  c.upsert('d', { startedAt: 3, notes: { summary: 'Agreed a budget', decisions: [], actions: [{ task: 'send contract' }], followUp: '' } });
  assert.deepStrictEqual((await c.list('budget')).map((x) => x.id), ['d', 'a']);
  assert.deepStrictEqual((await c.list('BUDGET tight')).map((x) => x.id), ['a']);
  assert.deepStrictEqual((await c.list('$4,500')).map((x) => x.id), ['b']);
  assert.deepStrictEqual((await c.list('contract')).map((x) => x.id), ['d']);
  assert.deepStrictEqual(await c.list('nothing like this'), []);
});

test('a changed call shows new text in search', async () => {
  const c = freshCalls();
  c.upsert('a', { startedAt: 1, notepad: 'first' });
  await c.list();
  await new Promise((r) => setTimeout(r, 5));
  c.upsert('a', { notepad: 'second' });
  assert.strictEqual((await c.list('second')).length, 1);
});

test('one broken file does not hide the rest', async () => {
  const c = freshCalls();
  c.upsert('good', { startedAt: 1 });
  fs.writeFileSync(path.join(c.dir, 'bad.json'), '{ not json');
  assert.deepStrictEqual((await c.list()).map((x) => x.id), ['good']);
});

test('the list says which file each call came from, so it is not imported twice', async () => {
  const c = freshCalls();
  c.upsert('c1762310000123', { startedAt: 1, file: '/calls/2026-11-05 0814 call.md' });
  assert.strictEqual((await c.list())[0].file, '/calls/2026-11-05 0814 call.md');
});

test('removing a call removes it', async () => {
  const c = freshCalls();
  c.upsert('a', { startedAt: 1 });
  await c.list();
  c.remove('a');
  assert.strictEqual(c.get('a'), null);
  assert.deepStrictEqual(await c.list(), []);
});

test('call ids cannot reach outside the library', () => {
  const c = freshCalls();
  assert.throws(() => c.upsert('../../evil', { startedAt: 1 }), /Not a call id/);
  assert.strictEqual(c.get('../settings'), null);
  assert.throws(() => c.remove('../settings'), /Not a call id/);
});

test('calls saved as markdown before the library can be read back', () => {
  const md = toMarkdown({
    startedAt: new Date(2026, 10, 4, 20, 9).getTime(),
    endedAt: new Date(2026, 10, 4, 20, 21).getTime(),
    lines: [
      { source: 'you', startMs: 1000, endMs: 3000, text: 'Hello there' },
      { source: 'them', startMs: 65000, endMs: 67000, text: 'How much is it?' },
    ],
    qa: [{ question: 'What did they ask?', answer: 'The price.', atMs: 70000 }],
    project: 'Acme',
  });
  const r = parseMarkdownCall(md, '2026-11-04 2009 call.md');
  assert.strictEqual(r.id, `c${new Date(2026, 10, 4, 20, 9).getTime()}`);
  assert.deepStrictEqual(r.lines.map((l) => [l.source, l.startMs, l.text]), [['you', 1000, 'Hello there'], ['them', 65000, 'How much is it?']]);
  assert.strictEqual(r.qa[0].answer, 'The price.');
  assert.strictEqual(r.project, 'Acme');
  assert.strictEqual(r.endedAt - r.startedAt, 12 * 60000);
});

test('other markdown files are left alone', () => {
  assert.strictEqual(parseMarkdownCall('# Shopping list', 'notes.md'), null);
  assert.strictEqual(parseMarkdownCall('# Nothing here', '2026-11-04 2009 call.md'), null);
});

// ---------- after-call notes ----------

const record = { project: 'Harbor', lines: [{ source: 'them', startMs: 0, text: 'What is the status?' }], notepad: 'Follow up on Dentrix' };

test('notes are built from the transcript and your notepad, and forbid invention', () => {
  const { system, prompt } = buildNotes({ record, template: 'sales', aboutMe: 'I am Sam.', instructions: 'Be brief.', brief: 'Pilot scoped.' });
  assert.match(prompt, /What is the status\?/);
  assert.match(prompt, /<user_notes>\nFollow up on Dentrix/);
  assert.match(prompt, /<project name="Harbor">\nPilot scoped\./);
  assert.match(prompt, /objections/);
  assert.match(system, /Never invent/);
  assert.match(system, /Be brief\./);
});

test('an unknown style falls back to general', () => {
  assert.strictEqual(templateOf('nope'), 'general');
  assert.match(buildNotes({ record, template: 'nope' }).prompt, /what was discussed/);
});

test('a very long transcript keeps its end', () => {
  const lines = Array.from({ length: 6000 }, (_, i) => ({ source: 'them', startMs: i * 1000, text: `line ${i} ${'x'.repeat(40)}` }));
  const { prompt } = buildNotes({ record: { lines } });
  assert.ok(prompt.length < 190000);
  assert.match(prompt, /line 5999 /);
});

test('parsing notes copes with code fences and odd shapes', () => {
  const n = parseNotes('```json\n{"summary":" Fine. ","decisions":["Go"," "],"actions":[{"task":"Send it","owner":"You"},{"owner":"x"}],"followUp":5}\n```');
  assert.deepStrictEqual(n, { summary: 'Fine.', decisions: ['Go'], actions: [{ task: 'Send it', owner: 'You' }], followUp: '' });
});

test('notes with no summary, or no JSON, count as failed', () => {
  assert.throws(() => parseNotes('sorry'), /did not return notes/);
  assert.throws(() => parseNotes('{"decisions":[]}'), /did not return notes/);
});

test('notes reach the saved call in a readable order', () => {
  const notesText = notesToMarkdown({ summary: 'We agreed a pilot.', decisions: ['Start Monday'], actions: [{ task: 'Send contract', owner: 'You' }], followUp: 'Thanks for the call.' });
  const md = toMarkdown({ startedAt: Date.now(), endedAt: Date.now(), lines: [], qa: [], title: 'Intro with Priya', attendees: ['Priya Nair'], statsLine: 'You 40%', notesText, notepad: 'Ask about Dentrix' });
  assert.match(md, /^# Intro with Priya, /);
  assert.match(md, /With: Priya Nair/);
  assert.match(md, /Talk time: You 40%/);
  assert.match(md, /- \[ \] You: Send contract/);
  assert.ok(md.indexOf('## Notes') < md.indexOf('## My notes'));
  assert.ok(md.indexOf('## My notes') < md.indexOf('## Transcript'));
});

// ---------- calendar ----------

const at = 1_000_000_000_000;
const min = 60000;
const ev = (fields) => ({ title: 'Event', start: at, end: at + 30 * min, allDay: false, attendees: [], ...fields });

test('the current event beats one that is over or far off', () => {
  const events = [ev({ title: 'Earlier', start: at - 90 * min, end: at - 30 * min }), ev({ title: 'Now', start: at - 5 * min }), ev({ title: 'Later', start: at + 60 * min, end: at + 90 * min })];
  assert.strictEqual(pickEvent(events, at).title, 'Now');
});

test('joining a little early still finds the event', () => {
  assert.strictEqual(pickEvent([ev({ title: 'Soon', start: at + 10 * min })], at).title, 'Soon');
  assert.strictEqual(pickEvent([ev({ start: at + 20 * min })], at), null);
});

test('all-day events are ignored, and events with people win', () => {
  assert.strictEqual(pickEvent([ev({ allDay: true })], at), null);
  const events = [ev({ title: 'Focus time' }), ev({ title: 'Intro', attendees: [{ name: 'Priya', email: 'p@acme.com' }] })];
  assert.strictEqual(pickEvent(events, at).title, 'Intro');
});

const clients = [
  { id: 'a', name: 'Acme Dental', brief: 'Contact: Priya Nair.' },
  { id: 'h', name: 'Harbor Clinic', brief: 'Contact: Tom Okafor.' },
];

test('a project matches on title, email domain or a contact in its brief', () => {
  assert.strictEqual(matchProject(ev({ title: 'Check-in: Acme Dental' }), clients), 'a');
  assert.strictEqual(matchProject(ev({ attendees: [{ name: 'X', email: 'x@harborclinic.com' }] }), clients), 'h');
  assert.strictEqual(matchProject(ev({ attendees: [{ name: 'Tom Okafor', email: 'tom@gmail.com' }] }), clients), 'h');
});

test('no match, or two matches, suggests nothing', () => {
  assert.strictEqual(matchProject(ev({ title: 'Lunch' }), clients), null);
  assert.strictEqual(matchProject(ev({ title: 'Acme Dental and Harbor Clinic' }), clients), null);
  assert.strictEqual(matchProject(null, clients), null);
  assert.strictEqual(matchProject(ev({ attendees: [{ name: 'Sam', email: 'sam@gmail.com' }] }), clients), null);
});

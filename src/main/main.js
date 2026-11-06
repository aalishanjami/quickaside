'use strict';

const {
  app,
  autoUpdater,
  BrowserWindow,
  crashReporter,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  clipboard,
  globalShortcut,
  screen,
  session,
  systemPreferences,
  nativeTheme,
} = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.env.QUICKASIDE_USER_DATA) app.setPath('userData', process.env.QUICKASIDE_USER_DATA);
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) app.commandLine.appendSwitch('no-sandbox');

const { Settings } = require('./settings');
const { childEnv, findBinary, expandHome, isInside } = require('./paths');
const { Segmenter } = require('./audio/segmenter');
const { SystemAudio } = require('./audio/system-audio');
const { WavFeeder } = require('./audio/test-feeder');
const { Transcriber, whisperPrompt } = require('./transcriber');
const { TranscriptStore, toMarkdown, looksLikeQuestion } = require('./transcript');
const { ClaudeSession } = require('./claude');
const { MODELS, modelPath, isDownloaded, downloadModel, getModel } = require('./models');
const { buildSystemPrompt, buildTurn, readContextFiles, QUICK_ACTIONS, buildAutoRequest } = require('./prompts');
const { settingsBounds, centeredBounds, panelBounds, promptBounds, MIN_WIDTH, MIN_HEIGHT, PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, PANEL_BAR_HEIGHT } = require('./window-layout');
const { CallDetector } = require('./call-detector');
const { DRAFT_FIELDS, buildDraft, parseDraft } = require('./assist');
const { scanFolder, describeContextFiles } = require('./knowledge');
const { Log } = require('./log');
const { Updater, repoFromIssues } = require('./updater');
const { CallStore, talkStats, callTitle, parseMarkdownCall, statsLine } = require('./calls');
const { NOTE_TEMPLATES, templateOf, buildNotes, parseNotes, notesToMarkdown } = require('./notes');
const { Calendar, pickEvent, matchProject } = require('./calendar');
const { Connector } = require('./connector');
const { bugs } = require('../../package.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const userData = app.getPath('userData');
app.setAppLogsPath(process.env.QUICKASIDE_USER_DATA ? path.join(userData, 'logs') : undefined);
const log = new Log(app.getPath('logs'));
crashReporter.start({ uploadToServer: false }); // dumps stay on this Mac
process.on('uncaughtException', (err) => log.error('crash.exception', { error: err }));
process.on('unhandledRejection', (err) => log.error('crash.rejection', { error: err }));
const modelsDir = path.join(userData, 'models');
const settings = new Settings(userData);
const testMode = {
  them: process.env.QUICKASIDE_TEST_AUDIO_THEM || null,
  you: process.env.QUICKASIDE_TEST_AUDIO_YOU || null,
  speed: Number(process.env.QUICKASIDE_TEST_SPEED || 1) || 1,
};

let win = null;
let settingsWin = null;
let promptWin = null;
let setupWin = null;
let libraryWin = null;
let tray = null;
let quitting = false;
let installing = false; // quitting to install an update, so windows must really close
let call = { active: false, stopping: false, startedAt: null, endedAt: null, file: null, app: null };
let qa = [];
let qaSeq = 1;
let segmenters = {};
let systemAudio = null;
let feeders = [];
let systemStatus = { state: 'off', error: null, hint: null };
let micStatus = { state: 'off', error: null };
let notesAccess = 'off'; // off | checking | ok | blocked | missing
let notesCheck = 0;
let notesProbe = null;
let download = null;
let whisperIdleTimer = null;
let autoTimer = null;
let autoFirst = null; // first line of the question waiting to be answered
let promptTimer = null;
let promptDismissed = false; // said no to this call, so don't ask again until it ends
let draftJob = null;
let callNotepad = ''; // what the user typed in the panel's notepad
let pendingEvent = null; // the calendar event this call looks like
const notesJobs = new Map(); // call id -> running job
let askJob = null;
let callNote = ''; // the one line typed for this call
let callNoteUsed = false; // it belongs to a call that has started, so the next one starts blank

const store = new TranscriptStore();
const calls = new CallStore(path.join(userData, 'calls'));
const connector = new Connector({
  resolveClaude,
  getEnv: () => childEnv(),
  execPath: process.execPath,
  appPath: app.getAppPath(),
  packaged: app.isPackaged,
  dataDir: userData,
  version: app.getVersion(),
});

// ---------- binaries ----------

function audioteePath() {
  return path.join(app.getAppPath(), 'node_modules', 'audiotee', 'bin', 'audiotee');
}

// Helpers ship inside the app. The data folder covers `npm start`, where they
// are built by setup.sh instead.
function bundledTool(name) {
  return path.join(app.getAppPath(), 'vendor', 'bin', name);
}

async function resolveWhisper() {
  const s = settings.get();
  const server = await findBinary('whisper-server', {
    explicit: expandHome(s.whisperServerPath),
    candidates: [bundledTool('whisper-server'), path.join(userData, 'bin', 'whisper-server')],
  });
  const cli = server ? null : await findBinary('whisper-cli');
  return { server, cli };
}

function resolveClaude() {
  return findBinary('claude', { explicit: expandHome(settings.get().claudePath) });
}

// ---------- Claude ----------

function currentProject() {
  const s = settings.get();
  return s.projects.find((p) => p.id === s.activeProject) || null;
}

function projectName() {
  const project = currentProject();
  return project ? project.name : '';
}

// A project folder only counts inside the notes folder, the one folder macOS
// access is checked for. Anywhere else, Claude could freeze on a prompt.
function projectFolder(project) {
  const notes = notesFolderInUse();
  const folder = project && project.folder ? expandHome(project.folder) : '';
  return notes && folder && isInside(notes, folder) ? folder : null;
}

function claudeConfig() {
  const s = settings.get();
  const folder = expandHome(s.contextFolder);
  const project = currentProject();
  const projectFiles = project ? project.files : [];
  // Claude runs inside this folder. If macOS has not allowed it yet, Claude
  // freezes on the prompt, so it runs without the folder until access is confirmed.
  const usableNotes = s.folderAccess && notesAccess === 'ok';
  return {
    model: s.claudeModel,
    effort: s.claudeEffort,
    folderAccess: usableNotes,
    folder,
    systemPrompt: buildSystemPrompt({
      aboutMe: s.aboutMe,
      offer: s.offer,
      audience: s.audience,
      instructions: s.instructions,
      // Project files go first, so they are the ones kept when the limit is reached.
      contextDocs: readContextFiles([...projectFiles, ...s.contextFiles].map(expandHome)),
      folderAccess: usableNotes,
      contextFolder: folder,
      project: project && { name: project.name, brief: project.brief, folder: projectFolder(project) },
      callNote,
    }),
  };
}

function buildMessage(item, { fresh }) {
  let lines;
  if (fresh) {
    store.resetSent();
    lines = store.takeAll();
  } else {
    lines = store.takeUnsent();
  }
  const end = call.active ? Date.now() : call.endedAt || Date.now();
  return buildTurn({
    fresh,
    startedAt: call.startedAt,
    elapsedMs: call.startedAt ? end - call.startedAt : 0,
    lines,
    request: item.request,
    callActive: call.active,
  });
}

const claude = new ClaudeSession({
  resolveClaude,
  getEnv: () => childEnv(),
  getConfig: claudeConfig,
  buildMessage,
  scratchDir: path.join(userData, 'claude-cwd'),
  log,
});

// Logs a state only when it changes, so a status tick can't flood the file.
const lastLogged = {};
function logState(name, fields) {
  const key = JSON.stringify(fields);
  if (lastLogged[name] === key) return;
  lastLogged[name] = key;
  log[fields.error ? 'warn' : 'info'](name, fields);
}

claude.on('status', () => {
  const { state, version, error } = claude.status;
  logState('claude.state', { state, version, error });
  emitStatus();
});
claude.on('answer', (ev) => {
  const item = qa.find((q) => q.id === ev.id);
  if (!item) return;
  if (ev.status) item.note = ev.status;
  if (typeof ev.text === 'string') item.answer = ev.text;
  if (ev.sources) item.sources = ev.sources;
  if (ev.done) {
    item.done = true;
    item.state = ev.error ? 'error' : ev.cancelled ? 'cancelled' : 'done';
    item.error = ev.error || null;
    item.note = null;
    item.durationMs = ev.durationMs || null;
    log[ev.error ? 'warn' : 'info']('answer.done', { kind: item.kind, state: item.state, ms: item.durationMs, notes: item.sources.length, error: ev.error });
    if (!call.active && call.startedAt) saveCall().catch(() => {});
  }
  send('qa:update', item);
});

function ask(text, kind = 'custom') {
  const clean = String(text || '').trim();
  let question = clean;
  let request = clean;
  if (QUICK_ACTIONS[kind]) {
    const last = kind === 'answer' ? store.lastQuestionFromThem() : null;
    request = QUICK_ACTIONS[kind].build(last ? last.text : undefined);
    question = last ? `Answer: "${last.text}"` : QUICK_ACTIONS[kind].label;
  } else if (kind === 'auto') {
    request = buildAutoRequest(clean);
  }
  if (!request) return null;
  const item = {
    id: qaSeq++,
    kind,
    question,
    request,
    answer: '',
    state: 'working',
    note: 'Starting',
    done: false,
    error: null,
    sources: [],
    atMs: call.startedAt ? Date.now() - call.startedAt : 0,
  };
  qa.push(item);
  send('qa:update', item);
  claude.ask({ id: item.id, request });
  return item.id;
}

// Every question gets an answer: Claude queues them, so one asked while another
// is being answered waits its turn. Lines from them that land before the timer
// fires join the same answer, because people often ask in two breaths.
function maybeAutoAnswer(line) {
  if (!settings.get().autoAnswer || !call.active || line.source !== 'them') return;
  if (!autoFirst && !looksLikeQuestion(line.text)) return;
  if (!autoFirst) autoFirst = line;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    const first = autoFirst;
    autoFirst = null;
    if (!call.active || !first) return;
    const from = Math.max(0, store.lines.findIndex((l) => l.id === first.id));
    const text = store.lines
      .slice(from)
      .filter((l) => l.source === 'them')
      .map((l) => l.text)
      .join(' ')
      .slice(0, 600);
    ask(text, 'auto');
  }, 1600);
}

// ---------- transcription ----------

const transcriber = new Transcriber({ resolveBinaries: resolveWhisper, getEnv: () => childEnv() });
transcriber.on('status', () => {
  const { state, mode, error } = transcriber.status;
  logState('whisper.state', { state, mode, error });
  emitStatus();
});
transcriber.on('line', (line) => {
  if (!call.startedAt) return;
  const added = store.add(line);
  if (added) maybeAutoAnswer(added);
});
transcriber.on('segment-error', (e) => log.warn('whisper.segment', { source: e.source, error: e.error }));
transcriber.on('segment-error', (e) => send('toast', { level: 'warn', message: `A ${e.source === 'you' ? 'mic' : 'call audio'} chunk failed: ${e.error}` }));

store.on('add', (line, beforeId) => send('transcript:add', { line, beforeId }));
store.on('remove', (id) => send('transcript:remove', id));

function whisperConfig() {
  const s = settings.get();
  const project = currentProject();
  const words = [project && project.name, s.vocabulary.trim()].filter(Boolean).join(', ');
  return {
    modelPath: modelPath(modelsDir, s.whisperModel),
    language: s.language,
    threads: s.whisperThreads,
    prompt: whisperPrompt(words),
  };
}

// ---------- calls ----------

function makeSegmenter(source) {
  const seg = new Segmenter({ source, now: () => Date.now() - call.startedAt });
  let lastLevel = 0;
  seg.on('level', (lv) => {
    const t = Date.now();
    if (t - lastLevel < 90) return;
    lastLevel = t;
    send('level', lv);
  });
  seg.on('segment', (s) => transcriber.enqueue(s));
  return seg;
}

async function preflight() {
  const s = settings.get();
  if (process.env.QUICKASIDE_WHISPER_URL) return null;
  const m = getModel(s.whisperModel);
  if (!isDownloaded(modelsDir, s.whisperModel)) {
    return `Download the ${m ? m.label.toLowerCase() : ''} speech model first (Settings, Transcription).`;
  }
  const { server, cli } = await resolveWhisper();
  if (!server && !cli) return 'Whisper is not installed. Run ./setup.sh in the quickaside folder, then restart the app.';
  return null;
}

async function startCall() {
  if (notesAccess !== 'checking') checkNotesAccess(); // access may have changed in System Settings
  if (call.active || call.stopping) return { ok: true };
  const problem = await preflight();
  if (problem) {
    log.warn('call.blocked', { error: problem });
    return { ok: false, error: problem };
  }
  const s = settings.get();
  clearTimeout(whisperIdleTimer);
  if (call.startedAt) await saveCall().catch(() => {});
  store.clear();
  qa = [];
  autoFirst = null;
  if (callNoteUsed) callNote = '';
  callNoteUsed = true;
  callNotepad = '';
  claude.reset();
  send('reset');

  const event = pendingEvent || (await currentEvent());
  pendingEvent = null;
  const startedAt = Date.now();
  call = {
    id: `c${startedAt}`,
    active: true,
    stopping: false,
    startedAt,
    endedAt: null,
    file: s.saveTranscripts ? transcriptPath(s) : null,
    app: detector.current,
    project: projectName(),
    note: callNote,
    title: event ? event.title : '',
    attendees: event ? event.attendees.map((a) => a.name || a.email).filter(Boolean) : [],
  };
  segmenters = { you: makeSegmenter('you'), them: makeSegmenter('them') };

  transcriber.start(whisperConfig()).catch((err) => {
    send('toast', { level: 'error', message: `Transcription could not start: ${err.message}` });
    stopCall().catch(() => {});
  });

  if (testMode.them) startFeeder('them', testMode.them);
  else if (s.captureSystem) await startSystemAudio();
  else systemStatus = { state: 'off', error: null, hint: null };

  const wantMic = s.captureMic && !testMode.you;
  micStatus = { state: wantMic ? 'starting' : 'off', error: null };
  if (testMode.you) startFeeder('you', testMode.you);

  claude.warm();
  emitStatus();
  log.info('call.start', { app: call.app, project: !!call.project, mic: wantMic, system: s.captureSystem, autoAnswer: s.autoAnswer });
  send('call:started', { captureMic: wantMic, micDeviceId: s.micDeviceId });
  return { ok: true };
}

function startFeeder(source, file) {
  try {
    const f = new WavFeeder(file, { speed: testMode.speed });
    feeders.push(f);
    if (source === 'them') systemStatus = { state: 'on', error: null, hint: null, test: true };
    else micStatus = { state: 'on', error: null };
    f.start((samples) => segmenters[source] && !call.paused && segmenters[source].push(samples));
  } catch (err) {
    send('toast', { level: 'error', message: `Test audio failed: ${err.message}` });
  }
}

async function startSystemAudio() {
  systemStatus = { state: 'starting', error: null, hint: null };
  const sa = new SystemAudio({ binaryPath: audioteePath(), env: process.env });
  sa.on('started', () => {
    systemStatus = { ...systemStatus, state: 'on' };
    emitStatus();
  });
  sa.on('data', (d) => {
    if (systemStatus.state === 'starting') {
      systemStatus = { ...systemStatus, state: 'on' };
      emitStatus();
    }
    if (segmenters.them && !call.paused) segmenters.them.push(d);
  });
  sa.on('error', (err) => {
    log.error('audio.system', { error: err });
    systemStatus = { state: 'error', error: err.message, hint: null };
    emitStatus();
  });
  try {
    sa.start();
    systemAudio = sa;
    const startedAt = call.startedAt;
    setTimeout(() => {
      if (systemAudio === sa && call.active && call.startedAt === startedAt && !sa.hasHeardAudio()) {
        systemStatus = { ...systemStatus, hint: 'silent' };
        log.warn('audio.system', { hint: 'silent for 20 seconds' });
        emitStatus();
      }
    }, 20000);
  } catch (err) {
    systemStatus = { state: 'error', error: err.message, hint: null };
  }
}

// Pause stops transcribing, for when someone asks. Audio still arrives and is dropped.
function setPaused(paused) {
  if (!call.active || !!call.paused === paused) return;
  call.paused = paused;
  if (paused) for (const seg of Object.values(segmenters)) seg.flush();
  log.info('call.pause', { paused });
  emitStatus();
}

async function stopCall() {
  if (!call.active) return { ok: true, file: call.file };
  call.active = false;
  call.stopping = true;
  call.endedAt = Date.now();
  clearTimeout(autoTimer);
  emitStatus();
  send('call:stopping');
  for (const f of feeders) f.stop();
  feeders = [];
  if (systemAudio) {
    const sa = systemAudio;
    systemAudio = null;
    await sa.stop();
  }
  systemStatus = { state: 'off', error: null, hint: null };
  await sleep(300); // let the last microphone frames arrive
  for (const seg of Object.values(segmenters)) seg.flush();
  await transcriber.drain(25000);
  segmenters = {};
  micStatus = { state: 'off', error: null };
  call.stopping = false;
  await saveCall().catch((err) => {
    log.error('call.save', { error: err });
    send('toast', { level: 'error', message: `Could not save transcript: ${err.message}` });
  });
  log.info('call.stop', { seconds: Math.round((call.endedAt - call.startedAt) / 1000), lines: store.lines.length, answers: qa.length });
  call.stats = talkStats(store.lines);
  emitStatus();
  send('calls:changed');
  if (settings.get().autoNotes && call.file && store.lines.length >= MIN_LINES_FOR_NOTES) writeNotes(call.id).catch(() => {});
  whisperIdleTimer = setTimeout(() => {
    if (!call.active) transcriber.stop().catch(() => {});
  }, 90000);
  return { ok: true, file: call.file };
}

function transcriptPath(s) {
  const dir = expandHome(s.saveFolder);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())} call`;
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} ${i}.md`);
  return file;
}

function writeMarkdown(record) {
  if (!record.file) return;
  fs.mkdirSync(path.dirname(record.file), { recursive: true });
  const md = toMarkdown({
    ...record,
    endedAt: record.endedAt || Date.now(),
    statsLine: statsLine(record.stats),
    notesText: record.notes ? notesToMarkdown(record.notes) : '',
  });
  fs.writeFileSync(record.file, md);
}

// Saving with nothing to save keeps "Save each call" meaning what it says: with
// it off, no record of the call is kept anywhere.
let saveChain = Promise.resolve();
function saveCall() {
  saveChain = saveChain.then(() => {
    if (!call.startedAt || !call.file) return;
    if (!store.lines.length && !qa.some((q) => q.answer)) return;
    // From the call, not the dropdown: a finished call is saved again when the
    // next one starts, and by then the dropdown may show a different project.
    const record = calls.upsert(call.id, {
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      app: call.app,
      title: call.title,
      attendees: call.attendees,
      project: call.project,
      note: call.note,
      file: call.file,
      notepad: callNotepad,
      lines: store.lines,
      qa: qa.map(({ kind, question, answer, sources, atMs, error }) => ({ kind, question, answer, sources, atMs, error })),
      stats: talkStats(store.lines),
    });
    writeMarkdown(record);
  });
  return saveChain;
}

// ---------- after-call notes ----------

const MIN_LINES_FOR_NOTES = 4;

function templateFor(record) {
  const s = settings.get();
  const project = s.projects.find((p) => p.name === record.project);
  return templateOf(record.template || (project && project.template) || s.noteTemplate);
}

async function writeNotes(id, template) {
  const record = calls.get(id);
  if (!record) return { ok: false, error: 'That call is gone.' };
  if (notesJobs.has(id)) return { ok: false, error: 'Already writing these notes.' };
  const s = settings.get();
  const chosen = templateOf(template || templateFor(record));
  const project = s.projects.find((p) => p.name === record.project);
  send('notes:update', { id, state: 'working' });
  const startedAt = Date.now();
  const job = claude.once({
    ...buildNotes({ record, template: chosen, aboutMe: s.aboutMe, instructions: s.instructions, brief: project ? project.brief : '' }),
    folder: null,
  });
  notesJobs.set(id, job);
  try {
    const { text } = await job.done;
    const notes = parseNotes(text);
    if (!calls.get(id)) return { ok: false, error: 'That call is gone.' };
    writeMarkdown(calls.upsert(id, { notes, template: chosen }));
    log.info('notes.done', { ms: Date.now() - startedAt, template: chosen, actions: notes.actions.length });
    send('notes:update', { id, state: 'done', notes, template: chosen });
    send('calls:changed');
    return { ok: true };
  } catch (err) {
    log.warn('notes.error', { error: err.message });
    send('notes:update', { id, state: 'error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    notesJobs.delete(id);
  }
}

// Calls saved as markdown before the library existed. The folder is listed in a
// child process first, so a blocked Documents folder can't hang this one.
async function importOldCalls() {
  const dir = expandHome(settings.get().saveFolder);
  if ((await probeFolder(dir, { keep: true })) !== 'ok') return;
  const library = await calls.list();
  const known = new Set(library.map((c) => c.id));
  // By file as well as id: a call saved by the library has an id to the
  // millisecond, and one read back from its file name only has the minute.
  const files = new Set(library.map((c) => c.file));
  let added = 0;
  for (const name of await fs.promises.readdir(dir)) {
    const file = path.join(dir, name);
    if (!name.endsWith('.md') || files.has(file)) continue;
    const record = parseMarkdownCall(await fs.promises.readFile(file, 'utf8'), name);
    if (!record || known.has(record.id)) continue;
    calls.upsert(record.id, { ...record, file });
    known.add(record.id);
    added++;
  }
  if (added) {
    log.info('calls.imported', { added });
    send('calls:changed');
  }
}

// ---------- connector ----------

async function connectorStatus() {
  const [claudeCode, library] = await Promise.all([connector.claudeCodeStatus(), calls.list()]);
  return { claudeCode, calls: library.length };
}

async function connectorStep(step, work) {
  try {
    await work();
    log.info('connector.step', { step });
    return { ok: true };
  } catch (err) {
    log.warn('connector.step', { step, error: err });
    return { ok: false, error: err.message };
  }
}

async function addToClaudeDesktop() {
  const file = await connector.buildBundle();
  const problem = await shell.openPath(file);
  if (problem) {
    shell.showItemInFolder(file);
    throw new Error('Claude Desktop did not open it. Is it installed?');
  }
}

// Reads the library with Claude. The files are the app's own, never the notes folder.
async function askCalls(question) {
  if (askJob) return { ok: false, error: 'Already looking.' };
  const dir = calls.dir;
  fs.mkdirSync(dir, { recursive: true });
  const job = claude.once({
    system: [
      'You answer questions about the user\'s past calls.',
      'Each JSON file in this folder is one call: startedAt, title, project, attendees, lines (the transcript), qa and notes.',
      'Use Grep and Glob to find the right calls, then read at most 8. Answer only from those files, and say which call each fact came from, by date. If the calls do not say, say so.',
      'Use short, plain words and no em dashes.',
    ].join('\n'),
    prompt: String(question).slice(0, 1000),
    folder: dir,
  });
  askJob = job;
  try {
    const { text, files } = await job.done;
    log.info('calls.ask', { files: files.length });
    return { ok: true, answer: text.trim(), calls: [...new Set(files.map((f) => path.basename(f, '.json')))] };
  } catch (err) {
    return { ok: false, cancelled: err.message === 'Cancelled.', error: err.message };
  } finally {
    askJob = null;
  }
}

// ---------- calendar ----------

function toolPath(name) {
  return [bundledTool(name), path.join(userData, 'bin', name)].find((p) => fs.existsSync(p)) || null;
}

const calendar = new Calendar({ resolveBinary: () => process.env.QUICKASIDE_CALENDAR || toolPath('calendar-helper'), log });

async function currentEvent() {
  if (!settings.get().useCalendar) return null;
  return pickEvent(await calendar.events());
}

// A match shows on the prompt, where it can be changed before pressing Start.
function suggestProject(event) {
  const s = settings.get();
  const id = matchProject(event, s.projects);
  if (!id || id === s.activeProject) return;
  const { settings: next } = settings.update({ activeProject: id });
  log.info('calendar.project', { matched: true });
  claude.configChanged();
  send('settings', next);
}

// ---------- notes folder ----------

// Runs in its own process: a read stuck on a macOS prompt inside this one
// would keep the app from quitting until someone answered the prompt.
function probeFolder(folder, { keep = false } = {}) {
  return new Promise((resolve) => {
    if (!keep) stopNotesProbe();
    const p = spawn('/bin/ls', ['--', folder], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!keep) notesProbe = p;
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    p.on('error', () => resolve('blocked'));
    p.on('close', (code) => {
      if (notesProbe === p) notesProbe = null;
      if (code === 0) resolve('ok');
      else resolve(/no such file/i.test(stderr) ? 'missing' : 'blocked');
    });
  });
}

function stopNotesProbe() {
  if (notesProbe) notesProbe.kill('SIGKILL');
  notesProbe = null;
}

// Reading the folder here raises any macOS prompt on the ready screen,
// not in the middle of the first question on a call.
async function checkNotesAccess() {
  const s = settings.get();
  const folder = s.folderAccess ? expandHome(s.contextFolder) : '';
  const seq = ++notesCheck;
  const set = (next) => {
    if (seq !== notesCheck || next === notesAccess) return;
    logState('notes.access', { state: next });
    const usableChanged = (next === 'ok') !== (notesAccess === 'ok');
    notesAccess = next;
    if (usableChanged) claude.configChanged();
    emitStatus();
  };
  if (!folder) {
    stopNotesProbe();
    return set('off');
  }
  set('checking');
  set(await probeFolder(folder));
}

// ---------- call detection ----------

function detectorPath() {
  if (process.env.QUICKASIDE_DETECTOR) return process.env.QUICKASIDE_DETECTOR;
  return toolPath('call-detector');
}

const detector = new CallDetector({ resolveBinary: detectorPath });
detector.on('status', () => {
  logState('detect.state', { state: detector.state });
  emitStatus();
});
detector.on('call', async ({ name }) => {
  log.info('detect.call', { app: name, active: call.active });
  const event = await currentEvent().catch(() => null);
  if (call.active) {
    call.app = name; // started by hand just before they joined
    if (event && !call.title) {
      call.title = event.title;
      call.attendees = event.attendees.map((a) => a.name || a.email).filter(Boolean);
    }
  } else {
    pendingEvent = event;
    if (event) suggestProject(event);
    if (!promptDismissed) showCallPrompt(name, event);
  }
  emitStatus();
});
detector.on('ended', () => {
  log.info('detect.ended');
  promptDismissed = false;
  pendingEvent = null;
  hideCallPrompt();
  if (call.active && call.app) stopCall().catch(() => {});
  emitStatus();
});

async function startListening({ focus }) {
  hideCallPrompt();
  showPanel({ focus });
  const r = await startCall();
  if (!r.ok) send('toast', { level: 'error', message: r.error });
  return r;
}

// ---------- drafts and knowledge ----------

function notesFolderInUse() {
  const s = settings.get();
  return s.folderAccess && notesAccess === 'ok' ? expandHome(s.contextFolder) : null;
}

// A suggested folder comes from Claude, so it has to prove it is really there.
function suggestedFolder(notes, relative) {
  if (!notes || !relative) return '';
  const full = path.resolve(notes, relative);
  return isInside(notes, full) && fs.existsSync(full) ? full : '';
}

async function runDraft(fields, projectId) {
  const wanted = (Array.isArray(fields) ? fields : []).filter((f) => f in DRAFT_FIELDS);
  if (!wanted.length) return { ok: false, error: 'Nothing to draft.' };
  if (draftJob) return { ok: false, error: 'Already drafting.' };
  const s = settings.get();
  const folder = notesFolderInUse();
  const project = s.projects.find((p) => p.id === projectId) || null;
  const contextDocs = readContextFiles([...(project ? project.files : []), ...s.contextFiles].map(expandHome));
  if (!folder && !contextDocs.length) {
    return { ok: false, code: 'no-sources', error: 'Connect a notes folder or add a context file first.' };
  }
  const job = claude.once({
    ...buildDraft({ fields: wanted, current: s, contextDocs, folder, project: project && { ...project, folder: projectFolder(project) } }),
    folder,
    onFile: (file) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('draft:progress', { file: path.basename(file) });
    },
  });
  draftJob = job;
  const startedAt = Date.now();
  log.info('draft.start', { fields: wanted.join(','), notes: !!folder });
  try {
    const { text, files } = await job.done;
    log.info('draft.done', { ms: Date.now() - startedAt, files: files.length });
    const values = parseDraft(text, wanted);
    if (values.projects) values.projects = values.projects.map((p) => ({ ...p, folder: suggestedFolder(folder, p.folder) }));
    return { ok: true, values, files: files.map((f) => path.basename(f)) };
  } catch (err) {
    log[err.message === 'Cancelled.' ? 'info' : 'warn']('draft.end', { error: err.message });
    return { ok: false, cancelled: err.message === 'Cancelled.', error: err.message };
  } finally {
    draftJob = null;
  }
}

async function knowledgeOverview() {
  const s = settings.get();
  const folder = notesFolderInUse();
  const [context, scan] = await Promise.all([describeContextFiles(s.contextFiles.map(expandHome)), folder ? scanFolder(folder) : null]);
  return { context, scan };
}

// ---------- updates ----------

const testFeed = process.env.QUICKASIDE_TEST_UPDATE_FEED; // a local stand-in for the update service
const updater = new Updater({
  autoUpdater,
  repo: repoFromIssues(bugs.url),
  version: app.getVersion(),
  // Only a real build can update, and tests must never replace the app.
  enabled: app.isPackaged && (!process.env.QUICKASIDE_USER_DATA || !!testFeed),
  ...(testFeed ? { feed: testFeed, firstCheckMs: 2000 } : {}),
  isBusy: () => call.active || call.stopping || !!detector.current || !!draftJob || !!download || notesJobs.size > 0,
  log,
});
updater.on('status', () => {
  trayState = null;
  emitStatus();
});
// A failed install leaves the app with no windows, so start it again.
updater.on('install-failed', () => {
  app.relaunch();
  app.exit(0);
});

function installUpdate() {
  return updater.install(() => {
    installing = true;
  });
}

// ---------- help ----------

function crashCount() {
  try {
    return fs.readdirSync(path.join(app.getPath('crashDumps'), 'completed')).filter((f) => f.endsWith('.dmp')).length;
  } catch {
    return 0;
  }
}

// What a bug report shares. Versions and states only: no names, paths or content.
function diagnostics() {
  const s = settings.get();
  const st = statusSnapshot();
  const model = getModel(s.whisperModel);
  const summary = [
    `${app.getName()} ${app.getVersion()}`,
    `macOS ${process.getSystemVersion()}, ${process.arch}, Electron ${process.versions.electron}`,
    `Claude Code: ${st.claude.version || 'not found'}, ${st.claude.state}${st.claude.model ? `, ${s.claudeModel}` : ''}`,
    `Speech: ${st.whisper.mode || 'not started'}, ${model ? model.label : s.whisperModel}, ${isDownloaded(modelsDir, s.whisperModel) ? 'downloaded' : 'not downloaded'}`,
    `Call detection: ${s.detectCalls ? st.detect.state : 'off'}`,
    `Access: microphone ${st.micAccess}, notes folder ${st.notes}`,
    `Capture: mic ${s.captureMic ? 'on' : 'off'}, call audio ${s.captureSystem ? 'on' : 'off'}`,
    `Answers: every question ${s.autoAnswer ? 'on' : 'off'}, ${s.projects.length} projects, ${s.contextFiles.length} context files`,
    `Connector: ${s.connector ? 'on' : 'off'}`,
    `Crash reports on this Mac: ${crashCount()}`,
  ].join('\n');
  return { summary, log: log.tail(150) };
}

function reportUrl() {
  const { summary } = diagnostics();
  const body = [
    '**What happened?**',
    '',
    '**What did you expect?**',
    '',
    '**Steps to get there**',
    '',
    '**Details**',
    '```',
    summary,
    '```',
    '',
    'The recent log was copied to your clipboard. Paste it below, after checking it.',
    '',
  ].join('\n');
  return `${bugs.url}/new?body=${encodeURIComponent(body)}`;
}

// ---------- state to renderer ----------

// The settings window only needs these; the panel gets everything.
const SHARED_CHANNELS = new Set(['status', 'models', 'model:progress', 'settings', 'notes:update', 'calls:changed']);
const PRIVACY_PANES = { microphone: 'Privacy_Microphone', 'call-audio': 'Privacy_ScreenCapture' };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (SHARED_CHANNELS.has(channel)) {
    for (const w of [settingsWin, setupWin, libraryWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
  if (channel === 'settings' && promptWin && !promptWin.isDestroyed()) promptWin.webContents.send(channel, payload);
}

function micAccess() {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted';
}

function statusSnapshot() {
  return {
    claude: claude.status,
    whisper: transcriber.status,
    system: systemStatus,
    mic: micStatus,
    micAccess: micAccess(),
    notes: notesAccess,
    detect: { state: detector.state, app: detector.current },
    update: { state: updater.state },
    note: callNote,
    call: { ...call },
    download: download ? { id: download.id, received: download.received, total: download.total } : null,
  };
}

let statusTimer = null;
function emitStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    send('status', statusSnapshot());
    refreshTray();
  }, 30);
}

function modelsList() {
  return MODELS.map((m) => ({ ...m, downloaded: isDownloaded(modelsDir, m.id) }));
}

function publicState() {
  return {
    settings: settings.get(),
    status: statusSnapshot(),
    lines: store.lines,
    qa,
    models: modelsList(),
    platform: process.platform,
    testMode: !!(testMode.them || testMode.you),
  };
}

// ---------- window ----------

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0e1113' : '#fbfbf9';
}

function applyTheme() {
  nativeTheme.themeSource = settings.get().theme; // theme.css follows prefers-color-scheme, which this sets
  for (const w of [win, settingsWin, promptWin, libraryWin]) if (w && !w.isDestroyed()) w.setBackgroundColor(windowBackground());
}

function secureWindow(w) {
  w.setContentProtection(!!settings.get().hideFromScreenShare);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}

function preferences(extra) {
  return {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    ...extra,
  };
}

// Calls are often full screen, and the panel and prompt have to show over them.
function floatOverEverything(w, level) {
  w.setAlwaysOnTop(true, level);
  if (process.platform === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

// The app lives in the menu bar, so these windows hide instead of closing. The
// panel has to stay loaded either way: its page runs the microphone.
function hideOnClose(w) {
  w.on('close', (e) => {
    if (quitting || installing) return;
    e.preventDefault();
    w.hide();
  });
}

function createPanel({ show }) {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  win = new BrowserWindow({
    ...panelBounds(screen.getPrimaryDisplay().workArea, settings.get().panelBounds, areas),
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
    show: false,
    frame: false,
    fullscreenable: false,
    acceptFirstMouse: true, // people click it from the call app, and the first click must count
    title: 'Quickaside',
    backgroundColor: windowBackground(),
    webPreferences: preferences({ backgroundThrottling: false }),
  });
  floatOverEverything(win, 'floating');
  secureWindow(win);
  hideOnClose(win);
  if (show) win.once('ready-to-show', () => showPanel({ focus: true }));
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const now = win.getBounds();
      settings.update({ panelBounds: panelFull ? { ...panelFull, x: now.x, y: now.y } : now });
    }, 500);
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Minimized, the panel shrinks to its title bar where it is, so the timer and the
// levels stay in view. The Dock is no use here: this app isn't in it.
let panelFull = null; // its bounds from before minimizing

function minimizePanel(on) {
  if (!win || on === !!panelFull) return;
  if (on) {
    panelFull = win.getBounds();
    win.setMinimumSize(PANEL_MIN_WIDTH, PANEL_BAR_HEIGHT);
    win.setBounds({ ...panelFull, height: PANEL_BAR_HEIGHT });
    win.setResizable(false);
  } else {
    const now = win.getBounds();
    const area = screen.getDisplayMatching(now).workArea;
    const y = Math.max(area.y, Math.min(now.y, area.y + area.height - panelFull.height)); // the bar may have been dragged low
    win.setResizable(true);
    win.setBounds({ ...panelFull, x: now.x, y });
    win.setMinimumSize(PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT);
    panelFull = null;
  }
  send('panel:minimized', on);
}

function showPanel({ focus }) {
  if (!win) return;
  if (focus) {
    minimizePanel(false);
    win.show();
    win.focus();
    app.focus({ steal: true });
  } else {
    win.showInactive(); // the user is in the call app, so leave them there
  }
}

function createPrompt() {
  promptWin = new BrowserWindow({
    ...promptBounds(screen.getPrimaryDisplay().workArea),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    title: 'Quickaside prompt',
    backgroundColor: windowBackground(),
    webPreferences: preferences(),
  });
  floatOverEverything(promptWin, 'screen-saver');
  secureWindow(promptWin);
  hideOnClose(promptWin);
  promptWin.on('closed', () => {
    promptWin = null;
  });
  promptWin.loadFile(path.join(__dirname, '..', 'renderer', 'prompt.html'));
}

function showCallPrompt(name, event) {
  if (win && win.isVisible()) return; // the panel's own home screen offers Start
  if (!promptWin) createPrompt();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  promptWin.setBounds(promptBounds(area));
  const reveal = () => {
    if (!promptWin) return;
    promptWin.webContents.send('prompt:show', { name, title: event ? event.title : '', settings: settings.get() });
    promptWin.showInactive();
  };
  if (promptWin.webContents.isLoading()) promptWin.webContents.once('did-finish-load', reveal);
  else reveal();
  clearTimeout(promptTimer);
  promptTimer = setTimeout(hideCallPrompt, 60000);
}

function hideCallPrompt() {
  clearTimeout(promptTimer);
  if (promptWin && !promptWin.isDestroyed()) promptWin.hide();
}

function openLibrary() {
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.show();
    libraryWin.focus();
    app.focus({ steal: true });
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1040, area.width - 40);
  const height = Math.min(720, area.height - 40);
  libraryWin = new BrowserWindow({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Past calls',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: windowBackground(),
    webPreferences: preferences(),
  });
  secureWindow(libraryWin);
  libraryWin.once('ready-to-show', () => {
    libraryWin.show();
    app.focus({ steal: true });
  });
  libraryWin.on('closed', () => {
    libraryWin = null;
  });
  libraryWin.loadFile(path.join(__dirname, '..', 'renderer', 'library.html'));
  importOldCalls().catch((err) => log.warn('calls.import', { error: err }));
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    app.focus({ steal: true });
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 560;
  const height = 640;
  setupWin = new BrowserWindow({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Set up Quickaside',
    titleBarStyle: 'hiddenInset',
    backgroundColor: windowBackground(),
    webPreferences: preferences(),
  });
  secureWindow(setupWin);
  setupWin.once('ready-to-show', () => {
    setupWin.show();
    app.focus({ steal: true });
  });
  setupWin.on('closed', () => {
    setupWin = null;
  });
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

function finishSetup() {
  settings.update({ setupDone: true });
  log.info('setup.done');
  trayState = null;
  emitStatus();
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  showPanel({ focus: true });
}

async function testClaude() {
  await claude.check();
  const { state, version } = claude.status;
  if (state === 'missing') return { state: 'missing' };
  try {
    await claude.once({ system: 'Reply with the single word: ready', prompt: 'Are you ready?', folder: null, timeoutMs: 60000 }).done;
    log.info('setup.claude', { state: 'ready' });
    return { state: 'ready', version };
  } catch (err) {
    log.warn('setup.claude', { error: err });
    return { state: 'error', error: err.message };
  }
}

// AudioTee records pure silence with no error when the permission is missing,
// so the only real proof is hearing something. The window plays a tone meanwhile.
async function testCallAudio(ms = 3000) {
  if (call.active) return { ok: false, error: 'End the call first.' };
  const sa = new SystemAudio({ binaryPath: audioteePath(), env: process.env });
  let failed = null;
  sa.on('error', (err) => {
    failed = err;
  });
  try {
    sa.start();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  await sleep(ms);
  const ok = sa.hasHeardAudio();
  await sa.stop();
  log.info('setup.audio', { ok, error: failed });
  return { ok, error: failed ? failed.message : null };
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Quickaside');
  refreshTray();
}

let trayState = null;
function refreshTray() {
  if (!tray) return;
  const next = `${call.active}|${call.paused}|${call.app}|${detector.current}|${updater.state}|${settings.get().setupDone}`;
  if (next === trayState) return;
  trayState = next;
  tray.setTitle(call.active ? 'Live' : '');
  const start = detector.current ? `Start on ${detector.current}` : 'Start now';
  const items = call.active
    ? [
        { label: call.app ? `Listening to ${call.app}` : 'Listening', enabled: false },
        { label: 'Show panel', click: () => showPanel({ focus: true }) },
        { label: call.paused ? 'Resume' : 'Pause', click: () => setPaused(!call.paused) },
        { label: 'End call', click: () => stopCall().catch(() => {}) },
      ]
    : [
        ...(settings.get().setupDone ? [] : [{ label: 'Finish setup', click: openSetup }]),
        { label: 'Open Quickaside', click: () => showPanel({ focus: true }) },
        { label: start, click: () => startListening({ focus: true }) },
      ];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...items,
      { type: 'separator' },
      ...(updater.state === 'ready' ? [{ label: 'Restart to update', enabled: !call.active, click: installUpdate }] : []),
      { label: 'Past calls', click: openLibrary },
      { label: 'Settings', click: () => openSettings() },
      { label: 'Report a problem', click: () => openSettings('help') },
      { type: 'separator' },
      { label: 'Quit Quickaside', click: () => app.quit() },
    ])
  );
}

function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (section) settingsWin.webContents.send('settings:section', section);
    settingsWin.show();
    settingsWin.focus();
    app.focus({ steal: true });
    return;
  }
  const panel = win.getBounds();
  const area = screen.getDisplayMatching(panel).workArea;
  const { clear, ...bounds } = win.isVisible() ? settingsBounds(panel, area) : centeredBounds(area);
  settingsWin = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Quickaside Settings',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: windowBackground(),
    webPreferences: preferences(),
  });
  // With no room beside the panel it would open underneath it.
  if (!clear) settingsWin.setAlwaysOnTop(true, 'floating');
  secureWindow(settingsWin);
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    app.focus({ steal: true });
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'), { query: section ? { section } : {} });
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const acc = settings.get().shortcut;
  if (!acc) return;
  try {
    const ok = globalShortcut.register(acc, () => {
      if (!win) return;
      if (promptWin && promptWin.isVisible()) startListening({ focus: false });
      else if (win.isVisible() && win.isFocused()) win.hide();
      else {
        showPanel({ focus: true });
        send('focus-input');
      }
    });
    if (!ok) send('toast', { level: 'warn', message: `Shortcut ${acc} is used by another app.` });
  } catch {
    send('toast', { level: 'warn', message: `Shortcut "${acc}" is not valid.` });
  }
}

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
}

// ---------- IPC ----------

const CLAUDE_KEYS = ['claudeModel', 'claudeEffort', 'aboutMe', 'offer', 'audience', 'instructions', 'projects', 'activeProject', 'contextFiles', 'folderAccess', 'contextFolder', 'claudePath'];
const WHISPER_KEYS = ['whisperModel', 'language', 'vocabulary', 'whisperThreads', 'whisperServerPath'];

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('settings:update', async (_e, partial) => {
    const { changed, settings: s } = settings.update(partial);
    log.info('settings.changed', { keys: changed.join(',') });
    if (changed.includes('theme')) applyTheme();
    if (changed.some((k) => CLAUDE_KEYS.includes(k))) claude.configChanged();
    if (call.active && (changed.includes('activeProject') || changed.includes('projects'))) call.project = projectName();
    if (changed.includes('activeProject') && call.active) claude.warm(); // switched mid-call, so be ready for the next question
    if (changed.includes('folderAccess') || changed.includes('contextFolder')) checkNotesAccess();
    if (changed.includes('claudePath')) {
      claude.caps = null;
      claude.check().catch(() => {});
    }
    if (changed.includes('hideFromScreenShare')) {
      for (const w of [win, settingsWin, promptWin, libraryWin]) if (w && !w.isDestroyed()) w.setContentProtection(s.hideFromScreenShare);
    }
    if (changed.includes('detectCalls')) {
      if (s.detectCalls) detector.start().catch(() => {});
      else detector.stop();
    }
    if (changed.includes('openAtLogin')) app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
    if (changed.includes('useCalendar') && s.useCalendar) {
      calendar.request().then((access) => {
        log.info('calendar.access', { access });
        if (access === 'granted') return;
        send('settings', settings.update({ useCalendar: false }).settings);
        send('toast', { level: 'warn', message: access === 'missing' ? 'The calendar helper is not installed.' : 'Allow Calendars in System Settings > Privacy & Security, then try again.' });
      });
    }
    if (changed.includes('connector') && s.connector) importOldCalls().catch((err) => log.warn('calls.import', { error: err }));
    if (changed.includes('shortcut')) registerShortcut();
    if (changed.some((k) => WHISPER_KEYS.includes(k)) && call.active) {
      transcriber.start(whisperConfig()).catch((err) => send('toast', { level: 'error', message: err.message }));
    }
    if (changed.includes('whisperModel')) send('models', modelsList());
    send('settings', s);
    return s;
  });

  ipcMain.handle('settings:open', (_e, section) => openSettings(section ? String(section) : null));

  ipcMain.handle('call:start', () => startCall());
  ipcMain.handle('call:stop', () => stopCall());

  ipcMain.handle('call:pause', (_e, paused) => setPaused(!!paused));

  ipcMain.handle('update:install', () => installUpdate());

  ipcMain.handle('notepad:set', (_e, text) => {
    callNotepad = String(text || '').slice(0, 20000);
    if (call.startedAt && !call.active) saveCall().catch(() => {});
  });

  ipcMain.handle('library:open', () => openLibrary());
  ipcMain.handle('calls:list', (_e, query) => calls.list(query));
  ipcMain.handle('calls:get', (_e, id) => {
    const record = calls.get(id);
    if (record) record.template = templateFor(record);
    return record;
  });
  ipcMain.handle('calls:templates', () => Object.entries(NOTE_TEMPLATES).map(([id, t]) => ({ id, label: t.label })));
  ipcMain.handle('calls:notes', (_e, id, template) => writeNotes(id, template));
  ipcMain.handle('calls:ask', (_e, question) => askCalls(question));
  ipcMain.handle('calls:ask-cancel', () => askJob && askJob.cancel());
  ipcMain.handle('calls:notepad', (_e, id, text) => {
    const record = calls.get(id);
    if (record) writeMarkdown(calls.upsert(id, { notepad: String(text || '').slice(0, 20000) }));
  });
  ipcMain.handle('calls:copy', (_e, id) => {
    const record = calls.get(id);
    if (record && record.notes) clipboard.writeText(`${callTitle(record)}\n\n${notesToMarkdown(record.notes)}`);
  });
  ipcMain.handle('calls:reveal', (_e, id) => {
    const record = calls.get(id);
    if (record && record.file) shell.showItemInFolder(record.file);
  });
  ipcMain.handle('calls:delete', async (e, id) => {
    const record = calls.get(id);
    if (!record) return false;
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) || win, {
      type: 'warning',
      buttons: ['Delete', 'Keep'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete ${callTitle(record)}?`,
      detail: 'This removes the call from the library, and its saved file. It cannot be undone.',
    });
    if (response !== 0) return false;
    // The last call is saved again when the next one starts, and notes may still
    // be on their way. Neither may bring it back.
    if (call.id === id) call.file = null;
    if (notesJobs.has(id)) notesJobs.get(id).cancel();
    calls.remove(id);
    if (record.file) fs.rmSync(record.file, { force: true });
    log.info('calls.delete');
    send('calls:changed');
    return true;
  });

  ipcMain.handle('connector:status', () => connectorStatus());
  ipcMain.handle('connector:connect', () => connectorStep('connect', () => connector.connectClaudeCode()));
  ipcMain.handle('connector:disconnect', () => connectorStep('disconnect', () => connector.disconnectClaudeCode()));
  ipcMain.handle('connector:desktop', () => connectorStep('desktop', addToClaudeDesktop));

  ipcMain.handle('setup:claude', () => testClaude());
  ipcMain.handle('setup:audio', () => testCallAudio());
  ipcMain.handle('setup:finish', () => finishSetup());
  ipcMain.handle('setup:privacy', (_e, which) => {
    const pane = PRIVACY_PANES[which];
    if (pane) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });

  ipcMain.handle('report:get', () => diagnostics());
  ipcMain.handle('report:open', async () => {
    clipboard.writeText(diagnostics().log);
    await shell.openExternal(reportUrl());
  });
  ipcMain.handle('report:reveal', () => shell.showItemInFolder(log.file));

  ipcMain.handle('panel:hide', () => win && win.hide());
  ipcMain.handle('panel:minimize', (_e, on) => minimizePanel(!!on));
  ipcMain.handle('prompt:start', () => startListening({ focus: false }));
  ipcMain.handle('prompt:dismiss', () => {
    promptDismissed = true;
    hideCallPrompt();
  });

  ipcMain.handle('note:set', (_e, text) => {
    callNote = String(text || '').slice(0, 300);
    callNoteUsed = call.active;
    if (call.active) call.note = callNote;
    claude.configChanged();
    if (call.active) claude.warm();
    emitStatus();
  });

  ipcMain.handle('draft:run', (_e, { fields, project }) => runDraft(fields, project));
  ipcMain.handle('draft:cancel', () => draftJob && draftJob.cancel());
  ipcMain.handle('knowledge:overview', () => knowledgeOverview());

  ipcMain.handle('qa:ask', (_e, { text, kind }) => ask(text, kind));
  ipcMain.handle('qa:cancel', (_e, id) => claude.cancel(id));

  ipcMain.handle('model:download', async (_e, id) => {
    if (download) return { ok: false, error: 'A download is already running.' };
    const controller = new AbortController();
    download = { id, received: 0, total: 0, controller };
    emitStatus();
    try {
      await downloadModel(
        modelsDir,
        id,
        (p) => {
          download.received = p.received;
          download.total = p.total;
          send('model:progress', p);
        },
        controller.signal
      );
      download = null;
      send('models', modelsList());
      emitStatus();
      return { ok: true };
    } catch (err) {
      download = null;
      emitStatus();
      const msg = err.name === 'AbortError' ? 'Download cancelled.' : err.message;
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle('model:cancel', () => {
    if (download) download.controller.abort();
  });

  ipcMain.handle('mic:ensure-access', async () => {
    if (process.platform !== 'darwin') return true;
    const st = systemPreferences.getMediaAccessStatus('microphone');
    if (st === 'granted') return true;
    if (st === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
    return false;
  });
  ipcMain.on('mic:pcm', (_e, buf) => {
    if (!call.active || call.paused || !segmenters.you) return;
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    segmenters.you.push(new Int16Array(ab));
  });
  ipcMain.on('mic:state', (_e, st) => {
    micStatus = { state: String(st?.state || 'off'), error: st?.error ? String(st.error) : null };
    logState('audio.mic', micStatus);
    emitStatus();
  });

  ipcMain.handle('dialog:files', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, {
      title: 'Context files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text', extensions: ['md', 'txt', 'markdown', 'csv', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:folder', async (e, title, defaultPath) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, {
      title: title || 'Choose a folder',
      defaultPath: defaultPath ? expandHome(defaultPath) : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('shell:open', async (_e, what) => {
    if (what === 'transcript' && call.file && fs.existsSync(call.file)) return shell.openPath(call.file);
    if (what === 'folder') {
      const dir = expandHome(settings.get().saveFolder);
      fs.mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    }
    if (what === 'notes') return shell.openPath(expandHome(settings.get().contextFolder));
    return 'nothing to open';
  });
  ipcMain.handle('shell:reveal', (_e, file) => {
    if (settings.get().contextFiles.includes(file)) shell.showItemInFolder(expandHome(file));
  });
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  log.info('app.start', { version: app.getVersion(), macos: process.getSystemVersion(), arch: process.arch, electron: process.versions.electron });
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // the installed app sets LSUIElement, this covers npm start
  // Updates can't replace an app running from a disk image.
  if (app.isPackaged && !process.env.QUICKASIDE_USER_DATA && !app.isInApplicationsFolder()) {
    try {
      if (app.moveToApplicationsFolder()) return;
    } catch (err) {
      log.warn('app.move', { error: err });
    }
  }
  applyTheme();
  setupPermissions();
  registerIpc();
  const atLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  const firstRun = !settings.get().setupDone;
  createPanel({ show: !atLogin && !firstRun });
  createPrompt();
  createTray();
  if (firstRun) openSetup();
  registerShortcut();
  checkNotesAccess();
  if (settings.get().connector) importOldCalls().catch((err) => log.warn('calls.import', { error: err }));
  if (settings.get().detectCalls) detector.start().catch(() => {});
  claude.check().then(() => emitStatus(), () => emitStatus());
  updater.start();
});

app.on('second-instance', () => showPanel({ focus: true }));
app.on('activate', () => showPanel({ focus: true }));

// Nothing to do here: the app stays in the menu bar to watch for calls.
app.on('window-all-closed', () => {});

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  log.info('app.quit', { callActive: call.active });
  // Saving can wait on transcription, but nothing may keep the app from quitting:
  // it has no windows to fall back on, so a stuck quit would leave it invisible.
  setTimeout(() => app.exit(0), 40000);
  (async () => {
    try {
      if (call.active) await stopCall();
      else await saveCall();
    } catch {}
    detector.stop();
    updater.stop();
    if (draftJob) draftJob.cancel();
    if (askJob) askJob.cancel();
    for (const job of notesJobs.values()) job.cancel();
    claude.dispose();
    stopNotesProbe();
    if (systemAudio) await systemAudio.stop().catch(() => {});
    await transcriber.stop().catch(() => {});
    globalShortcut.unregisterAll();
    // Not app.quit(): with nothing to save this runs inside the before-quit
    // above, whose preventDefault then cancels the quit after the windows close.
    app.exit(0);
  })();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaults() {
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  return {
    // Claude
    claudeModel: 'sonnet', // haiku | sonnet | opus, passed to `claude --model`
    claudeEffort: 'low', // low keeps answers fast during a live call
    aboutMe: '',
    offer: '',
    audience: '',
    instructions: 'Short, plain words. No em dashes.',
    contextFiles: [], // files whose text is given to Claude at the start of each session
    folderAccess: false, // let Claude read files in contextFolder with Read/Glob/Grep
    contextFolder: '',
    knowledgeSummary: '', // written by the spark button on the Knowledge page
    knowledgeTopics: [],
    projects: [], // { id, name, brief, folder, files }, see cleanProject
    activeProject: '', // id of the project calls are about, '' for none
    // Transcription
    whisperModel: appleSilicon ? 'large-v3-turbo-q5_0' : 'base.en',
    language: 'en',
    vocabulary: '', // names and terms Whisper should spell right
    // Audio
    captureMic: true,
    captureSystem: true,
    micDeviceId: 'default',
    // Behaviour
    autoAnswer: true,
    autoNotes: true, // write up each call when it ends
    noteTemplate: 'general',
    useCalendar: false, // read the current event to name calls and suggest projects
    connector: false, // let the user's own Claude read saved calls, see src/connector
    detectCalls: true, // show the small prompt when a call app takes the mic
    openAtLogin: false,
    showTranscript: false,
    panelBounds: null,
    setupDone: false, // the first-run window has been finished
    hideFromScreenShare: false,
    consentReminder: true, // remind the user to tell people, when each call starts
    theme: 'system', // system | light | dark
    saveTranscripts: true,
    saveFolder: path.join(os.homedir(), 'Documents', 'Callaside'),
    shortcut: 'CommandOrControl+Shift+Space',
    // Advanced overrides
    claudePath: '',
    whisperServerPath: '',
    whisperThreads: 4,
  };
}

const CHOICES = {
  claudeModel: ['haiku', 'sonnet', 'opus'],
  claudeEffort: ['low', 'medium', 'high'],
  language: ['en', 'auto'],
  theme: ['system', 'light', 'dark'],
  noteTemplate: ['general', 'sales', 'interview', 'oneone'],
};

const MAX_PROJECTS = 40;

function cleanProject(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return null;
  return {
    id: p.id.slice(0, 40),
    name: String(p.name || '').slice(0, 120),
    brief: String(p.brief || '').slice(0, 8000),
    folder: typeof p.folder === 'string' ? p.folder : '',
    files: Array.isArray(p.files) ? p.files.filter((f) => typeof f === 'string' && f.trim()) : [],
    template: typeof p.template === 'string' ? p.template : '',
  };
}

function hasContent(p) {
  return !!(p.name.trim() || p.brief.trim() || p.folder || p.files.length);
}

class Settings {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...this._clean(saved) };
      this.data.projects = this.data.projects.filter(hasContent); // a New project click left blank
      // Settings from before the setup window existed: this Mac is already set up.
      if (!('setupDone' in saved)) this.data.setupDone = true;
    } catch {
      // first run or unreadable file: keep defaults
    }
  }

  get() {
    return { ...this.data, contextFiles: [...this.data.contextFiles] };
  }

  update(partial) {
    const clean = this._clean(partial || {});
    this.data = { ...this.data, ...clean };
    this._save();
    return { changed: Object.keys(clean), settings: this.get() };
  }

  _clean(input) {
    const base = defaults();
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (!(key in base)) continue;
      const want = base[key];
      if (key === 'panelBounds') {
        if (value && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(value[k]))) out[key] = value;
      } else if (key === 'projects') {
        if (Array.isArray(value)) out[key] = value.map(cleanProject).filter(Boolean).slice(0, MAX_PROJECTS);
      } else if (Array.isArray(want)) {
        if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === 'string' && v.trim());
      } else if (typeof want === 'number') {
        const n = Number(value);
        if (Number.isFinite(n)) out[key] = Math.max(1, Math.min(16, Math.round(n)));
      } else if (typeof value === typeof want) {
        if (CHOICES[key] && !CHOICES[key].includes(value)) continue;
        out[key] = typeof value === 'string' ? value.slice(0, 20000) : value;
      }
    }
    return out;
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, defaults };

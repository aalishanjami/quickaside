'use strict';

(() => {
  const api = window.callaside;
  const $ = (id) => document.getElementById(id);
  const { el, basename, tildify, toast } = window.ui;

  const FOLDER_ISSUES = {
    checking: 'Waiting for you to answer the macOS prompt. Answers skip this folder until then.',
    blocked: 'macOS is blocking this folder, so answers skip it. Allow Callaside in System Settings > Privacy & Security > Files & Folders.',
    missing: 'This folder no longer exists, so answers skip it. Choose another one.',
  };

  const PROFILE_FIELDS = ['aboutMe', 'offer', 'audience', 'instructions'];

  // whisper reads this much of the vocabulary as its prompt (see whisperConfig).
  const TERM_LIMIT = 600;

  const state = {
    settings: null,
    status: null,
    models: [],
    testMode: false,
    download: null,
    knowledge: null,
    knowledgeSeq: 0,
    drafting: false,
    newTerms: new Set(),
    connector: null,
    connectorSeq: 0,
    openProject: null,
  };

  // ---------- sections ----------

  function showSection(name) {
    const pages = [...document.querySelectorAll('[data-page]')];
    const target = pages.some((p) => p.dataset.page === name) ? name : 'you';
    for (const p of pages) p.hidden = p.dataset.page !== target;
    for (const b of document.querySelectorAll('.nav-item')) {
      if (b.dataset.section === target) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    $('content').scrollTop = 0;
    if (target === 'listening') refreshMicList();
    if (target === 'knowledge') refreshKnowledge();
    if (target === 'help') refreshReport();
    if (target === 'connect') refreshConnector();
  }

  async function refreshReport() {
    const { summary, log } = await api.report();
    $('reportText').value = `${summary}\n\n${log || '(the log is empty)'}`;
  }

  function onPage(name) {
    return !document.querySelector(`[data-page="${name}"]`).hidden;
  }

  // ---------- connect ----------

  const CODE_STATUS = {
    connected: 'Connected. Start a new Claude Code session to use it.',
    off: 'Not connected.',
    moved: 'Connected to another copy of this app. Connect again to fix it.',
    failed: 'Set up, but it did not start. Connect again to fix it.',
    missing: 'Claude Code was not found.',
  };

  function renderConnector() {
    const on = !!state.settings.connector;
    $('connectorTargets').hidden = !on;
    $('connectorTips').hidden = !on;
    const c = state.connector;
    if (!c) return;
    $('connectorCodeStatus').textContent = CODE_STATUS[c.claudeCode];
    $('connectorCode').textContent = c.claudeCode === 'connected' ? 'Disconnect' : 'Connect';
    $('connectorCode').disabled = c.claudeCode === 'missing';
    const saved = c.calls === 1 ? '1 saved call' : `${c.calls} saved calls`;
    $('connectorHelp').textContent = `${saved}, with transcripts and notes. Claude can't change or delete anything here.`;
  }

  async function refreshConnector() {
    const seq = ++state.connectorSeq;
    const c = await api.connectorStatus();
    if (seq !== state.connectorSeq) return;
    state.connector = c;
    renderConnector();
  }

  async function connectorAction(button, work, done) {
    button.disabled = true;
    const result = await work();
    button.disabled = false;
    if (result.ok) {
      if (done) toast(done, { timeout: 4000 });
    } else {
      toast(result.error, { level: 'error' });
    }
    refreshConnector();
  }

  // ---------- rendering ----------

  function render() {
    const s = state.settings;
    for (const input of document.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      if (!(key in s)) continue;
      if (input.type === 'checkbox') input.checked = !!s[key];
      else if (document.activeElement !== input) input.value = s[key] ?? '';
    }
    for (const radio of document.querySelectorAll('.seg input[type="radio"]')) {
      if (radio.name in s) radio.checked = s[radio.name] === radio.value;
    }
    renderKnowledge();
    renderTerms();
    // Rebuilding the list mid-typing would throw away the cursor.
    if (!$('projectList').contains(document.activeElement)) renderProjects();
    $('contextFolderPath').textContent = s.contextFolder ? tildify(s.contextFolder) : 'No folder chosen';
    $('contextFolderPath').classList.toggle('unset', !s.contextFolder);
    $('saveFolderPath').textContent = tildify(s.saveFolder);
    renderConnector();
    renderModels();
  }

  // ---------- knowledge ----------

  async function refreshKnowledge() {
    const seq = ++state.knowledgeSeq;
    const k = await api.knowledge();
    if (seq !== state.knowledgeSeq) return;
    state.knowledge = k;
    renderKnowledge();
  }

  function ago(ms) {
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderKnowledge() {
    const s = state.settings;
    const scan = state.knowledge && state.knowledge.scan;
    const filled = PROFILE_FIELDS.filter((f) => s[f] && s[f].trim()).length;
    $('kProfile').textContent = `${filled}/${PROFILE_FIELDS.length}`;
    $('kContext').textContent = String(s.contextFiles.length);
    const notes = state.status && state.status.notes;
    $('kNotes').textContent = !s.folderAccess || !s.contextFolder ? 'Off' : scan ? scan.files.toLocaleString() : notes === 'ok' ? '...' : '0';
    renderScan(s.folderAccess ? scan : null);
    renderFiles();
    $('kSummary').textContent = s.knowledgeSummary || 'Press the spark for a quick read of what is in here.';
    $('kSummary').classList.toggle('unset', !s.knowledgeSummary);
    $('kTopics').replaceChildren(...s.knowledgeTopics.map((t) => el('span', 'topic', t)));
  }

  function renderScan(scan) {
    $('folderScan').hidden = !scan;
    if (!scan) return;
    const facts = [
      ['Notes', scan.partial ? `${scan.files.toLocaleString()}+` : scan.files.toLocaleString()],
      ['Folders', scan.folders.toLocaleString()],
      ['Edited this week', scan.recent.toLocaleString()],
    ];
    const box = $('folderFacts');
    box.replaceChildren();
    for (const [label, value] of facts) {
      const row = el('div');
      row.appendChild(el('dd', null, value));
      row.appendChild(el('dt', null, label));
      box.appendChild(row);
    }
    const most = scan.top.length ? scan.top[0].count : 1;
    const bars = $('folderTop');
    bars.replaceChildren();
    for (const { name, count } of scan.top) {
      const li = el('li');
      li.appendChild(el('span', 'bar-name', name));
      const track = el('span', 'bar-track');
      const fill = el('span', 'bar-fill');
      fill.style.transform = `scaleX(${count / most})`;
      track.appendChild(fill);
      li.appendChild(track);
      li.appendChild(el('span', 'bar-count', count.toLocaleString()));
      bars.appendChild(li);
    }
    const types = scan.types.map((t) => `${t.count.toLocaleString()} ${t.name}`).join(', ');
    const latest = scan.latest ? `Last edit: ${scan.latest.name}, ${ago(scan.latest.mtimeMs)}.` : '';
    $('folderTypes').textContent = [types && `${types}.`, latest].filter(Boolean).join(' ');
  }

  const FILE_STATES = {
    cut: 'Cut at 40,000 characters',
    'left-out': 'Left out, over the limit',
    missing: 'File not found',
  };

  function renderFiles() {
    const list = $('contextFiles');
    const files = state.settings.contextFiles;
    const context = state.knowledge && state.knowledge.context;
    list.replaceChildren();
    files.forEach((f, i) => {
      const info = context && context.files[i];
      const li = el('li');
      li.title = f;
      const text = el('button', 'file-text');
      text.type = 'button';
      text.onclick = () => api.reveal(f);
      text.appendChild(el('span', 'file-name', basename(f)));
      text.appendChild(el('span', 'file-path', tildify(f)));
      li.appendChild(text);
      if (info) {
        const issue = FILE_STATES[info.state];
        li.appendChild(el('span', `file-state${issue ? ' warn' : ''}`, issue || fileSize(info.size)));
      }
      const rm = el('button', 'text-btn', 'Remove');
      rm.type = 'button';
      rm.onclick = () => save({ contextFiles: state.settings.contextFiles.filter((x) => x !== f) });
      li.appendChild(rm);
      list.appendChild(li);
    });
    list.hidden = !files.length;
    const hasBudget = !!(context && files.length);
    $('budget').hidden = !hasBudget;
    if (hasBudget) $('budgetFill').style.transform = `scaleX(${Math.min(1, context.used / context.limit)})`;
    $('budgetText').textContent = hasBudget
      ? `${context.used.toLocaleString()} of ${context.limit.toLocaleString()} characters used. Each file is cut at 40,000.`
      : files.length
        ? ''
        : 'No files yet. Add the few that matter on most calls.';
  }

  // ---------- spark drafts ----------

  function setDrafting(on, button) {
    state.drafting = on;
    for (const b of document.querySelectorAll('.spark, #draftAll, #suggestProjects')) b.disabled = on;
    if (button) button.classList.toggle('busy', on);
    $('draftBar').hidden = !on;
    $('draftText').textContent = 'Reading your knowledge';
  }

  async function draft(fields, button, project) {
    if (state.drafting) return null;
    flush();
    setDrafting(true, button);
    const r = await api.draft(fields, project);
    setDrafting(false, button);
    if (r.ok) return r;
    if (r.cancelled) return null;
    if (r.code === 'no-sources') toast(r.error, { action: { label: 'Open Knowledge', run: () => showSection('knowledge') } });
    else toast(r.error || 'Could not draft that.', { level: 'error', timeout: 9000 });
    return null;
  }

  function usedNotes(files) {
    if (!files.length) return '';
    return ` Used ${files.length} note${files.length === 1 ? '' : 's'}.`;
  }

  function flash(key) {
    const box = document.querySelector(`[data-key="${key}"]`);
    if (!box) return;
    box.classList.add('drafted');
    setTimeout(() => box.classList.remove('drafted'), 2500);
  }

  async function draftProfile(fields, button) {
    const r = await draft(fields, button);
    if (!r) return;
    const patch = {};
    const undo = {};
    for (const f of fields) {
      const value = r.values[f];
      if (!value || value === state.settings[f]) continue;
      patch[f] = value;
      undo[f] = state.settings[f];
    }
    const keys = Object.keys(patch);
    if (!keys.length) {
      toast('Nothing new for this in your knowledge yet.');
      return;
    }
    save(patch);
    keys.forEach(flash);
    toast(`Drafted ${keys.length === 1 ? 'this' : `${keys.length} fields`}. Check it reads right.${usedNotes(r.files)}`, {
      timeout: 12000,
      action: { label: 'Undo', run: () => save(undo) },
    });
  }

  async function draftTerms(button) {
    const r = await draft(['vocabulary'], button);
    if (!r) return;
    const before = state.settings.vocabulary;
    const current = terms();
    const known = new Set(current.map((t) => t.toLowerCase()));
    const found = r.values.vocabulary.filter((t) => !known.has(t.toLowerCase()));
    if (!found.length) {
      toast('No new names or terms in your knowledge.');
      return;
    }
    state.newTerms = new Set(found);
    setTerms([...current, ...found]);
    toast(`Added ${found.length} name${found.length === 1 ? '' : 's'} and terms.${usedNotes(r.files)}`, {
      timeout: 12000,
      action: {
        label: 'Undo',
        run: () => {
          state.newTerms = new Set();
          save({ vocabulary: before });
        },
      },
    });
  }

  async function draftKnowledge(button) {
    const r = await draft(['knowledge'], button);
    if (!r) return;
    const { summary, topics } = r.values.knowledge;
    if (!summary) {
      toast('There was nothing to sum up yet.');
      return;
    }
    save({ knowledgeSummary: summary, knowledgeTopics: topics });
  }

  // ---------- projects ----------

  function projects() {
    return state.settings.projects;
  }

  function saveProjects(list, delay = 0) {
    state.settings.projects = list;
    save({ projects: list }, delay);
  }

  function updateProject(id, patch, delay = 0) {
    saveProjects(
      projects().map((p) => (p.id === id ? { ...p, ...patch } : p)),
      delay
    );
  }

  function newProject(fields = {}) {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return { id, name: '', brief: '', folder: '', files: [], ...fields };
  }

  function projectSummary(p) {
    const parts = [];
    if (p.brief.trim()) parts.push('Brief');
    if (p.folder) parts.push(basename(p.folder));
    if (p.files.length) parts.push(`${p.files.length} file${p.files.length === 1 ? '' : 's'}`);
    return parts.join(', ') || 'Empty';
  }

  function sparkIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#spark');
    svg.appendChild(use);
    return svg;
  }

  function renderProjects() {
    const list = $('projectList');
    list.replaceChildren(...projects().map(projectRow));
    list.hidden = !projects().length;
    $('projectsEmpty').hidden = projects().length > 0;
  }

  function projectRow(p) {
    const open = state.openProject === p.id;
    const li = el('li', `project${open ? ' open' : ''}`);
    const head = el('button', 'project-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.onclick = () => {
      flush();
      state.openProject = open ? null : p.id;
      renderProjects();
    };
    const name = el('span', 'project-name', p.name || 'Untitled');
    head.appendChild(name);
    if (state.settings.activeProject === p.id) head.appendChild(el('span', 'project-active', 'In use'));
    const summary = el('span', 'project-summary', projectSummary(p));
    head.appendChild(summary);
    li.appendChild(head);
    if (open) li.appendChild(projectBody(p, name, summary));
    return li;
  }

  function projectBody(p, name, summary) {
    const body = el('div', 'project-body');

    const nameField = el('label', 'project-field');
    nameField.appendChild(el('span', 'field-title', 'Name'));
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = p.name;
    nameInput.placeholder = 'Acme Dental';
    nameInput.addEventListener('input', () => {
      updateProject(p.id, { name: nameInput.value }, 700);
      name.textContent = nameInput.value || 'Untitled';
    });
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    const briefField = el('div', 'project-field');
    const briefHead = el('div', 'field-head');
    const briefLabel = el('label', 'field-title', 'Brief');
    briefLabel.htmlFor = `brief-${p.id}`;
    briefHead.appendChild(briefLabel);
    const spark = el('button', 'spark');
    spark.type = 'button';
    spark.title = 'Draft from your knowledge';
    spark.setAttribute('aria-label', 'Draft this brief from your knowledge');
    spark.appendChild(sparkIcon());
    spark.onclick = () => draftBrief(p.id, spark);
    briefHead.appendChild(spark);
    briefField.appendChild(briefHead);
    briefField.appendChild(el('span', 'field-help', 'Who it is for, where it stands and what matters. Answers read this first, so they need no search for it.'));
    const brief = el('textarea');
    brief.id = `brief-${p.id}`;
    brief.rows = 6;
    brief.value = p.brief;
    brief.addEventListener('input', () => {
      updateProject(p.id, { brief: brief.value }, 700);
      summary.textContent = projectSummary({ ...p, brief: brief.value });
    });
    briefField.appendChild(brief);
    body.appendChild(briefField);

    const folderField = el('div', 'project-field');
    folderField.appendChild(el('span', 'field-title', 'Folder'));
    folderField.appendChild(el('span', 'field-help', 'Searched before the rest of your notes.'));
    const row = el('div', 'path-row');
    const path = el('span', `path${p.folder ? '' : ' unset'}`, p.folder ? tildify(p.folder) : 'No folder');
    path.title = p.folder;
    row.appendChild(path);
    if (p.folder) {
      const clear = el('button', 'text-btn', 'Clear');
      clear.type = 'button';
      clear.onclick = () => {
        updateProject(p.id, { folder: '' });
        renderProjects();
      };
      row.appendChild(clear);
    }
    const pick = el('button', 'btn', 'Choose folder');
    pick.type = 'button';
    pick.onclick = () => chooseProjectFolder(p.id);
    row.appendChild(pick);
    folderField.appendChild(row);
    body.appendChild(folderField);

    const filesField = el('div', 'project-field');
    const filesHead = el('div', 'field-head');
    filesHead.appendChild(el('span', 'field-title', 'Files'));
    const add = el('button', 'btn small', 'Add files');
    add.type = 'button';
    add.onclick = async () => {
      const files = await api.pickFiles();
      if (!files.length) return;
      updateProject(p.id, { files: [...new Set([...p.files, ...files])] });
      renderProjects();
    };
    filesHead.appendChild(add);
    filesField.appendChild(filesHead);
    filesField.appendChild(el('span', 'field-help', 'Read in full at the start of a call on this project.'));
    if (p.files.length) {
      const files = el('ul', 'file-list');
      for (const f of p.files) {
        const item = el('li');
        const text = el('span', 'file-text');
        text.appendChild(el('span', 'file-name', basename(f)));
        text.appendChild(el('span', 'file-path', tildify(f)));
        item.appendChild(text);
        const rm = el('button', 'text-btn', 'Remove');
        rm.type = 'button';
        rm.onclick = () => {
          updateProject(p.id, { files: p.files.filter((x) => x !== f) });
          renderProjects();
        };
        item.appendChild(rm);
        files.appendChild(item);
      }
      filesField.appendChild(files);
    }
    body.appendChild(filesField);

    const styleField = el('label', 'project-field');
    styleField.appendChild(el('span', 'field-title', 'Style of notes'));
    const style = el('select');
    for (const [value, label] of [
      ['', 'Same as Answers'],
      ['general', 'General'],
      ['sales', 'Sales call'],
      ['interview', 'Interview'],
      ['oneone', 'One to one'],
    ]) {
      const o = el('option', null, label);
      o.value = value;
      style.appendChild(o);
    }
    style.value = p.template || '';
    style.addEventListener('change', () => updateProject(p.id, { template: style.value }));
    styleField.appendChild(style);
    body.appendChild(styleField);

    const del = el('button', 'text-btn project-delete', 'Delete project');
    del.type = 'button';
    del.onclick = () => deleteProject(p);
    body.appendChild(del);
    return body;
  }

  function deleteProject(p) {
    const before = projects();
    const wasActive = state.settings.activeProject === p.id;
    state.openProject = null;
    saveProjects(before.filter((x) => x.id !== p.id));
    if (wasActive) save({ activeProject: '' });
    renderProjects();
    toast(`Deleted ${p.name || 'the project'}.`, {
      timeout: 10000,
      action: {
        label: 'Undo',
        run: () => {
          saveProjects(before);
          if (wasActive) save({ activeProject: p.id });
          renderProjects();
        },
      },
    });
  }

  async function chooseProjectFolder(id) {
    const notes = state.settings.contextFolder.replace(/\/+$/, '');
    if (!notes) {
      toast('Choose a notes folder first.', { action: { label: 'Open Knowledge', run: () => showSection('knowledge') } });
      return;
    }
    const dir = await api.pickFolder('Project folder, inside your notes folder', notes);
    if (!dir) return;
    if (!dir.startsWith(`${notes}/`)) {
      toast('Pick a folder inside your notes folder.', { level: 'error' });
      return;
    }
    updateProject(id, { folder: dir });
    renderProjects();
  }

  async function draftBrief(id, button) {
    const p = projects().find((x) => x.id === id);
    if (!p.name.trim()) {
      toast('Name the project first.');
      return;
    }
    const r = await draft(['projectBrief'], button, id);
    if (!r) return;
    const value = r.values.projectBrief;
    const current = projects().find((x) => x.id === id);
    if (!value || value === current.brief) {
      toast('Nothing new on this project in your knowledge.');
      return;
    }
    const before = current.brief;
    updateProject(id, { brief: value });
    renderProjects();
    toast(`Drafted the brief. Check it reads right.${usedNotes(r.files)}`, {
      timeout: 12000,
      action: {
        label: 'Undo',
        run: () => {
          updateProject(id, { brief: before });
          renderProjects();
        },
      },
    });
  }

  // Added straight away, with Undo. A list to tick looked saved when it wasn't,
  // and it was gone once the window closed.
  async function suggestProjects(button) {
    const r = await draft(['projects'], button);
    if (!r) return;
    const known = new Set(projects().map((p) => p.name.trim().toLowerCase()));
    const added = r.values.projects
      .filter((p) => !known.has(p.name.toLowerCase()))
      .map(({ name, brief, folder }) => newProject({ name, brief, folder }));
    if (!added.length) {
      toast('No new projects in your notes.');
      return;
    }
    const ids = new Set(added.map((p) => p.id));
    saveProjects([...projects(), ...added]);
    renderProjects();
    toast(`Added ${added.length} project${added.length === 1 ? '' : 's'}. Check they read right.${usedNotes(r.files)}`, {
      timeout: 12000,
      action: {
        label: 'Undo',
        run: () => {
          saveProjects(projects().filter((p) => !ids.has(p.id)));
          renderProjects();
        },
      },
    });
  }

  // ---------- names and terms ----------

  function parseTerms(text) {
    return [
      ...new Set(
        String(text || '')
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean)
      ),
    ];
  }

  function terms() {
    return parseTerms(state.settings.vocabulary);
  }

  function setTerms(list) {
    const vocabulary = list.join(', ');
    state.settings.vocabulary = vocabulary;
    save({ vocabulary });
    renderTerms();
  }

  function renderTerms() {
    const box = $('terms');
    const input = $('termInput');
    for (const chip of box.querySelectorAll('.term')) chip.remove();
    const list = terms();
    let length = 0;
    for (const t of list) {
      length += t.length + 2;
      const over = length - 2 > TERM_LIMIT;
      const chip = el('span', `term${over ? ' over' : ''}${state.newTerms.has(t) ? ' new' : ''}`);
      chip.appendChild(el('span', null, t));
      const x = el('button', 'term-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${t}`);
      x.onclick = () => setTerms(terms().filter((v) => v !== t));
      chip.appendChild(x);
      box.insertBefore(chip, input);
    }
    const total = list.join(', ').length;
    const count = `${list.length} term${list.length === 1 ? '' : 's'}`;
    $('termBudget').textContent = !list.length
      ? 'Press the spark to pull names from your knowledge, or type one and press Enter.'
      : total > TERM_LIMIT
        ? `${count}. Speech recognition only reads the first ${TERM_LIMIT} characters, so the dimmed ones are left out.`
        : `${count}, ${total} of ${TERM_LIMIT} characters.`;
  }

  function bindTerms() {
    const input = $('termInput');
    const commit = () => {
      const added = parseTerms(input.value);
      input.value = '';
      if (added.length) setTerms([...new Set([...terms(), ...added])]);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !input.value) {
        setTerms(terms().slice(0, -1));
      }
    });
    input.addEventListener('blur', commit);
    $('terms').addEventListener('click', (e) => {
      if (e.target === $('terms')) input.focus();
    });
  }

  function renderModels() {
    const box = $('modelList');
    box.replaceChildren();
    for (const m of state.models) {
      const item = el('label', 'seg-item tall');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'whisperModel';
      radio.checked = state.settings.whisperModel === m.id;
      radio.onchange = () => save({ whisperModel: m.id });
      item.appendChild(radio);
      item.appendChild(el('span', 'seg-title', m.label));
      item.appendChild(el('span', 'seg-sub', m.size));
      item.appendChild(el('span', 'seg-note', m.note));
      const d = state.download;
      if (m.downloaded) item.appendChild(el('span', 'seg-state ok', 'Ready'));
      else if (d && d.id === m.id) {
        const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
        item.appendChild(el('span', 'seg-state', `${pct}%`));
      } else if (!state.testMode) {
        const b = el('button', 'btn small', 'Download');
        b.type = 'button';
        b.onclick = (e) => {
          e.preventDefault();
          startDownload(m.id);
        };
        item.appendChild(b);
      }
      box.appendChild(item);
    }
  }

  function renderFolderIssue() {
    const text = FOLDER_ISSUES[state.status && state.status.notes];
    $('folderIssue').textContent = text || '';
    $('folderIssue').hidden = !text;
    const st = state.status;
    $('updateGroup').hidden = !(st && st.update.state === 'ready');
    if (st) $('installUpdate').disabled = !!st.call.active;
    $('detectIssue').hidden = !(st && state.settings.detectCalls && st.detect.state === 'missing');
  }

  function renderAbout() {
    const st = state.status;
    if (!st) return;
    const version = st.claude.version ? `Claude Code ${st.claude.version}` : st.claude.state === 'missing' ? 'Claude Code not found' : 'Checking Claude Code';
    const speech = { server: 'whisper-server', cli: 'whisper-cli, slower' }[st.whisper.mode] || st.whisper.mode;
    $('aboutStatus').replaceChildren(el('span', null, version));
    if (speech) $('aboutStatus').appendChild(el('span', null, speech));
  }

  async function startDownload(id) {
    const r = await api.downloadModel(id);
    if (!r.ok) toast(r.error || 'Download failed.', { level: 'error' });
  }

  async function refreshMicList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const sel = $('micSelect');
      const current = state.settings.micDeviceId;
      sel.replaceChildren();
      const def = el('option', null, 'System default');
      def.value = 'default';
      sel.appendChild(def);
      let i = 1;
      for (const d of devices.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default')) {
        const o = el('option', null, d.label || `Microphone ${i++}`);
        o.value = d.deviceId;
        sel.appendChild(o);
      }
      sel.value = [...sel.options].some((o) => o.value === current) ? current : 'default';
    } catch {}
  }

  // ---------- saving ----------

  let saveTimer = null;
  let pending = {};
  function flush() {
    clearTimeout(saveTimer);
    if (!Object.keys(pending).length) return;
    const p = pending;
    pending = {};
    api.updateSettings(p); // the result comes back through the 'settings' event
  }

  function save(patch, delay = 0) {
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function bind() {
    for (const input of document.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      if (input.type === 'checkbox') input.addEventListener('change', () => save({ [key]: input.checked }));
      else if (input.tagName === 'SELECT') input.addEventListener('change', () => save({ [key]: input.value }));
      else {
        input.addEventListener('input', () => save({ [key]: input.value }, 700));
        input.addEventListener('change', () => save({ [key]: input.value }));
      }
    }
    for (const radio of document.querySelectorAll('.seg input[type="radio"]')) {
      radio.addEventListener('change', () => save({ [radio.name]: radio.value }));
    }
    for (const b of document.querySelectorAll('.nav-item')) b.onclick = () => showSection(b.dataset.section);
    $('addFiles').onclick = async () => {
      const files = await api.pickFiles();
      if (files.length) save({ contextFiles: [...new Set([...state.settings.contextFiles, ...files])] });
    };
    bindTerms();
    $('connectorCode').onclick = () => {
      const connected = state.connector && state.connector.claudeCode === 'connected';
      if (connected) connectorAction($('connectorCode'), api.disconnectClaudeCode, 'Disconnected.');
      else connectorAction($('connectorCode'), api.connectClaudeCode, 'Connected.');
    };
    $('connectorDesktop').onclick = () => connectorAction($('connectorDesktop'), api.addToClaudeDesktop);
    $('installUpdate').onclick = () => api.installUpdate();
    $('reportIssue').onclick = () => api.openReport();
    $('showLog').onclick = () => api.revealLog();
    $('copyReport').onclick = () => {
      api.copy($('reportText').value);
      toast('Copied.', { timeout: 2000 });
    };
    $('newProject').onclick = () => {
      const p = newProject();
      state.openProject = p.id;
      saveProjects([...projects(), p]);
      renderProjects();
      $('projectList').querySelector('.project.open input').focus();
    };
    $('suggestProjects').onclick = () => suggestProjects($('suggestProjects'));
    for (const b of document.querySelectorAll('[data-draft]')) b.onclick = () => draftProfile([b.dataset.draft], b);
    $('draftAll').onclick = () => draftProfile(PROFILE_FIELDS, $('draftAll'));
    $('draftTerms').onclick = () => draftTerms($('draftTerms'));
    $('draftKnowledge').onclick = () => draftKnowledge($('draftKnowledge'));
    $('draftStop').onclick = () => api.cancelDraft();
    $('tileProfile').onclick = () => showSection('you');
    $('openNotes').onclick = () => api.open('notes');
    $('pickContextFolder').onclick = async () => {
      const dir = await api.pickFolder('Notes folder to search during calls');
      if (dir) save({ contextFolder: dir, folderAccess: true });
    };
    $('pickSaveFolder').onclick = async () => {
      const dir = await api.pickFolder('Where to save call transcripts');
      if (dir) save({ saveFolder: dir });
    };
    $('openSaveFolder').onclick = () => api.open('folder');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.close();
    });
    // Typing is saved on a delay, and closing the window must not lose it.
    window.addEventListener('beforeunload', flush);

    api.on('calls:changed', () => onPage('connect') && refreshConnector());
    api.on('settings', (s) => {
      state.settings = s;
      render();
      if (onPage('knowledge')) refreshKnowledge();
    });
    api.on('status', (st) => {
      const notesChanged = state.status && state.status.notes !== st.notes;
      state.status = st;
      state.download = st.download;
      renderAbout();
      renderFolderIssue();
      if (notesChanged && onPage('knowledge')) refreshKnowledge();
    });
    api.on('draft:progress', ({ file }) => {
      $('draftText').textContent = `Reading ${file}`;
    });
    api.on('models', (list) => {
      state.models = list;
      renderModels();
    });
    api.on('model:progress', (p) => {
      state.download = p.done ? null : p;
      renderModels();
    });
    api.on('settings:section', showSection);
  }

  async function init() {
    const s = await api.getState();
    state.settings = s.settings;
    state.status = s.status;
    state.models = s.models;
    state.testMode = s.testMode;
    state.download = s.status.download;
    document.body.classList.add(`platform-${s.platform}`);
    render();
    renderAbout();
    renderFolderIssue();
    bind();
    showSection(new URLSearchParams(location.search).get('section') || 'you');
  }

  init();
})();

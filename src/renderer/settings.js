'use strict';

(() => {
  const api = window.quickaside;
  const $ = (id) => document.getElementById(id);
  const { el, basename, tildify, toast } = window.ui;

  const FOLDER_ISSUES = {
    checking: 'Waiting for you to answer the macOS prompt. Answers skip this folder until then.',
    blocked: 'macOS is blocking this folder, so answers skip it. Allow Quickaside in System Settings > Privacy & Security > Files & Folders.',
    missing: 'This folder no longer exists, so answers skip it. Choose another one.',
  };

  const PROFILE_FIELDS = ['aboutMe', 'offer', 'audience'];

  // whisper reads this much of the vocabulary as its prompt (see whisperConfig).
  const TERM_LIMIT = 600;

  const state = {
    settings: null,
    status: null,
    drafting: false,
    newTerms: new Set(),
    connector: null,
    connectorSeq: 0,
    openProject: null,
  };

  // ---------- sections ----------

  // Two pages: Projects, and one that scrolls through You, Calls and Help.
  function showSection(name) {
    const projects = name === 'projects';
    for (const p of document.querySelectorAll('[data-page]')) p.hidden = p.dataset.page !== (projects ? 'projects' : 'settings');
    $('content').scrollTop = 0;
    if (projects) return;
    refreshConnector();
    const part = $(`part-${name}`);
    if (part && name !== 'you') part.scrollIntoView();
  }

  async function refreshReport() {
    const { summary, log } = await api.report();
    $('reportText').value = `${summary}\n\n${log || '(the log is empty)'}`;
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
    const c = state.connector;
    if (!c) return;
    $('connectorCodeStatus').textContent = CODE_STATUS[c.claudeCode];
    $('connectorCode').textContent = c.claudeCode === 'connected' ? 'Disconnect' : 'Connect';
    $('connectorCode').disabled = c.claudeCode === 'missing';
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
    renderFiles();
    renderTerms();
    // Rebuilding the list mid-typing would throw away the cursor.
    if (!$('projectList').contains(document.activeElement)) renderProjects();
    $('contextFolderPath').textContent = s.contextFolder ? tildify(s.contextFolder) : 'No folder chosen';
    $('contextFolderPath').classList.toggle('unset', !s.contextFolder);
    $('clearNotes').hidden = !s.contextFolder;
    $('saveFolderPath').textContent = tildify(s.saveFolder);
    renderConnector();
  }

  // ---------- files ----------

  function renderFiles() {
    const list = $('contextFiles');
    const files = state.settings.contextFiles;
    list.replaceChildren();
    for (const f of files) {
      const li = el('li');
      li.title = f;
      const text = el('button', 'file-text');
      text.type = 'button';
      text.onclick = () => api.reveal(f);
      text.appendChild(el('span', 'file-name', basename(f)));
      text.appendChild(el('span', 'file-path', tildify(f)));
      li.appendChild(text);
      const rm = el('button', 'text-btn', 'Remove');
      rm.type = 'button';
      rm.onclick = () => save({ contextFiles: state.settings.contextFiles.filter((x) => x !== f) });
      li.appendChild(rm);
      list.appendChild(li);
    }
    list.hidden = !files.length;
  }

  // ---------- spark drafts ----------

  function setDrafting(on, button) {
    state.drafting = on;
    for (const b of document.querySelectorAll('.spark, #draftAll, #suggestProjects, #pasteForm button')) b.disabled = on;
    if (button) button.classList.toggle('busy', on);
    $('draftBar').hidden = !on;
    $('draftText').textContent = 'Reading your notes and Claude Code memory';
  }

  async function draft(fields, button, project, pasted) {
    if (state.drafting) return null;
    flush();
    setDrafting(true, button);
    const r = await api.draft(fields, project, pasted);
    setDrafting(false, button);
    if (r.ok) return r;
    if (r.cancelled) return null;
    toast(r.error || 'Could not draft that.', { level: 'error', timeout: 9000 });
    return null;
  }

  // What a draft read, so it is clear where the words came from.
  function usedSources(r) {
    const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
    const parts = [];
    if (r.files.length) parts.push(count(r.files.length, 'note', 'notes'));
    if (r.memory) parts.push(count(r.memory, 'Claude Code memory', 'Claude Code memories'));
    if (r.calls) parts.push(count(r.calls, 'past call', 'past calls'));
    return parts.length ? ` Used ${parts.join(', ')}.` : '';
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
      toast('Nothing new to add yet.');
      return;
    }
    save(patch);
    keys.forEach(flash);
    toast(`Drafted ${keys.length === 1 ? 'this' : `${keys.length} fields`}. Check it reads right.${usedSources(r)}`, {
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
      toast('No new names or terms found.');
      return;
    }
    state.newTerms = new Set(found);
    setTerms([...current, ...found]);
    toast(`Added ${found.length} name${found.length === 1 ? '' : 's'} and terms.${usedSources(r)}`, {
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
    spark.title = 'Draft this for me';
    spark.setAttribute('aria-label', 'Draft this brief for me');
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

    if (state.settings.contextFolder) {
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
    }

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
      toast('Nothing new on this project yet.');
      return;
    }
    const before = current.brief;
    updateProject(id, { brief: value });
    renderProjects();
    toast(`Drafted the brief. Check it reads right.${usedSources(r)}`, {
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
  async function suggestProjects(button, pasted) {
    const r = await draft(['projects'], button, null, pasted);
    if (!r) return;
    const known = new Set(projects().map((p) => p.name.trim().toLowerCase()));
    const added = r.values.projects
      .filter((p) => !known.has(p.name.toLowerCase()))
      .map(({ name, brief, folder }) => newProject({ name, brief, folder }));
    if (!added.length) {
      toast('No new projects found. After a call with a new client, it offers to save one.', { timeout: 9000 });
      return;
    }
    const ids = new Set(added.map((p) => p.id));
    saveProjects([...projects(), ...added]);
    renderProjects();
    toast(`Added ${added.length} project${added.length === 1 ? '' : 's'}. Check they read right.${usedSources(r)}`, {
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
      ? 'Press the spark to find them for you, or type one and press Enter.'
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
    $('reportDetails').addEventListener('toggle', () => $('reportDetails').open && refreshReport());
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
    $('draftAll').onclick = () => draftProfile(PROFILE_FIELDS, $('draftAll'));
    $('draftTerms').onclick = () => draftTerms($('draftTerms'));
    $('draftStop').onclick = () => api.cancelDraft();
    $('pasteMemory').onclick = () => {
      $('pasteForm').hidden = !$('pasteForm').hidden;
      if (!$('pasteForm').hidden) $('pasteText').focus();
    };
    $('pasteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('pasteText').value.trim();
      if (!text) return;
      await suggestProjects($('suggestProjects'), text);
      $('pasteText').value = '';
      $('pasteForm').hidden = true;
    });
    $('clearNotes').onclick = () => save({ contextFolder: '', folderAccess: false });
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
      if (e.key === 'Escape') api.showView('now');
    });
    // Typing is saved on a delay, and leaving the page must not lose it.
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);

    api.on('settings', (s) => {
      state.settings = s;
      render();
    });
    api.on('status', (st) => {
      state.status = st;
      renderAbout();
      renderFolderIssue();
    });
    api.on('draft:progress', ({ file }) => {
      $('draftText').textContent = `Reading ${file}`;
    });
    api.on('settings:section', ({ section, find }) => {
      showSection(section);
      if (find) suggestProjects($('suggestProjects'));
    });
  }

  async function init() {
    const s = await api.getState();
    state.settings = s.settings;
    state.status = s.status;
    document.body.classList.add(`platform-${s.platform}`);
    render();
    renderAbout();
    renderFolderIssue();
    bind();
    const query = new URLSearchParams(location.search);
    showSection(query.get('section') || 'you');
    if (query.get('find')) suggestProjects($('suggestProjects'));
  }

  init();
})();

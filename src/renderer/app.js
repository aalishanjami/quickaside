'use strict';

(() => {
  const api = window.callaside;
  const $ = (id) => document.getElementById(id);
  const { el, basename, tildify, modelName, toast, usableProjects, fillProjects } = window.ui;

  const QUICK = [
    ['answer', 'Answer them', 'Words to answer the last question they asked'],
    ['next', 'Next move', 'What to say next, one or two options'],
    ['summary', 'Summary', 'Their situation, needs, concerns and anything agreed'],
    ['actions', 'Action items', 'Action items and open questions so far'],
  ];

  // Quick actions name themselves. Only these two need a label over the question.
  const ASKED_BY = { auto: 'They asked', custom: 'You asked' };

  // Notes folder states that mean answers are running without it.
  const NOTES_ISSUES = {
    checking: 'Allow the macOS prompt',
    blocked: 'Folder blocked by macOS',
    missing: 'Notes folder not found',
  };

  // A line to paste into the meeting chat. Telling people is the user's job, so make it one click.
  const HEADS_UP = "Heads up: I'm using an AI note taker on this call. Tell me if you'd rather I didn't.";

  // Past this length an answer drops from cue size to reading size.
  const LONG_ANSWER = 260;

  const state = {
    settings: null,
    status: null,
    models: [],
    testMode: false,
    lines: new Map(), // id -> { data, el }
    qa: new Map(), // id -> { data, el }
    mic: null,
    download: null,
    timer: null,
    noticeDone: false, // the consent reminder has been dealt with for this call
    notepadOpen: false,
    callNotes: null, // { state, notes, error } for the call that just ended
  };

  // ---------- helpers ----------

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  }

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  }

  function scrollBottom(box) {
    box.scrollTop = box.scrollHeight;
  }

  // ---------- transcript ----------

  function addLine(line, beforeId) {
    $('transcriptEmpty').hidden = true;
    const box = $('transcript');
    const stick = nearBottom(box);
    const row = el('div', `line ${line.source}`);
    row.dataset.id = line.id;
    row.appendChild(el('span', 't', fmt(line.startMs)));
    row.appendChild(el('span', 'who', line.source === 'you' ? 'You' : 'Them'));
    row.appendChild(el('span', 'text', line.text));
    $('lastLine').textContent = `${line.source === 'you' ? 'You' : 'Them'}: ${line.text}`;
    const before = beforeId != null ? state.lines.get(beforeId) : null;
    if (before) box.insertBefore(row, before.el);
    else box.appendChild(row);
    state.lines.set(line.id, { data: line, el: row });
    markContinuation(row);
    if (row.nextElementSibling) markContinuation(row.nextElementSibling);
    if (stick) scrollBottom(box);
    else $('jumpLive').hidden = false;
    renderStage();
  }

  function markContinuation(row) {
    const prev = row.previousElementSibling;
    const same = prev && prev.classList.contains('line') && prev.classList.contains(row.classList.contains('you') ? 'you' : 'them');
    row.classList.toggle('cont', !!same);
  }

  function removeLine(id) {
    const entry = state.lines.get(id);
    if (!entry) return;
    const next = entry.el.nextElementSibling;
    entry.el.remove();
    state.lines.delete(id);
    if (next && next.classList.contains('line')) markContinuation(next);
  }

  function transcriptText() {
    return [...state.lines.values()]
      .map(({ data }) => data)
      .sort((a, b) => a.startMs - b.startMs)
      .map((l) => `[${fmt(l.startMs)}] ${l.source === 'you' ? 'You' : 'Them'}: ${l.text}`)
      .join('\n');
  }

  // ---------- answers ----------

  // Newest answer sits on top in large type. Older ones shrink below it.
  function upsertQa(item) {
    const box = $('answers');
    let entry = state.qa.get(item.id);
    if (!entry) {
      const card = el('article', 'qa');
      const q = el('button', 'q');
      q.type = 'button';
      q.onclick = () => {
        if (!card.classList.contains('latest')) card.classList.toggle('open');
      };
      q.appendChild(el('span', 'kind'));
      q.appendChild(el('span', 'qtext'));
      card.appendChild(q);
      card.appendChild(el('div', 'a md'));
      card.appendChild(el('div', 'sources'));
      const meta = el('div', 'meta');
      meta.appendChild(el('span', 'note'));
      const copy = el('button', 'text-btn copy', 'Copy');
      copy.type = 'button';
      copy.onclick = () => {
        api.copy(entry.data.answer || '');
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      };
      const stop = el('button', 'text-btn stop', 'Cancel');
      stop.type = 'button';
      stop.onclick = () => api.cancel(entry.data.id);
      meta.appendChild(copy);
      meta.appendChild(stop);
      card.appendChild(meta);
      const previous = box.firstElementChild;
      if (previous) previous.classList.remove('latest');
      card.classList.add('latest');
      box.prepend(card);
      box.scrollTop = 0;
      entry = { data: item, el: card };
      state.qa.set(item.id, entry);
    }
    entry.data = item;
    const card = entry.el;
    card.classList.toggle('auto', item.kind === 'auto');
    card.querySelector('.kind').textContent = ASKED_BY[item.kind] || '';
    card.querySelector('.qtext').textContent = item.question;
    const a = card.querySelector('.a');
    card.classList.toggle('error', item.state === 'error');
    card.classList.toggle('working', !item.done);
    card.classList.toggle('long', (item.answer || '').length > LONG_ANSWER);
    if (item.state === 'error') {
      a.textContent = item.error || 'Something went wrong.';
    } else if (item.answer) {
      a.innerHTML = window.renderMarkdown(item.answer);
    } else if (!item.done) {
      a.replaceChildren(el('span', 'waiting', item.note || 'Thinking'));
    } else {
      a.textContent = item.state === 'cancelled' ? 'Stopped.' : '';
    }
    let note = '';
    if (!item.done) note = item.answer ? item.note || 'Writing' : '';
    else if (item.state === 'cancelled') note = 'Stopped';
    else if (item.durationMs) {
      const model = state.status && modelName(state.status.claude.model);
      note = [`${(item.durationMs / 1000).toFixed(1)}s`, model].filter(Boolean).join(' · ');
    }
    card.querySelector('.note').textContent = note;
    renderSources(card.querySelector('.sources'), item.sources);
    card.querySelector('.stop').hidden = item.done;
    card.querySelector('.copy').hidden = !item.answer;
    renderStage();
  }

  // Which notes this answer opened, so it is clear where the words came from.
  function renderSources(box, sources) {
    box.replaceChildren();
    if (!sources || !sources.length) return;
    box.appendChild(el('span', 'sources-label', 'From your notes'));
    for (const file of sources) {
      const name = el('span', 'source-name', basename(file));
      name.title = tildify(file);
      box.appendChild(name);
    }
  }

  function clearAll() {
    for (const { el: e } of state.lines.values()) e.remove();
    for (const { el: e } of state.qa.values()) e.remove();
    state.lines.clear();
    state.qa.clear();
    $('transcriptEmpty').hidden = false;
    $('jumpLive').hidden = true;
    $('lastLine').textContent = '';
    renderStage();
  }

  // ---------- status ----------

  function applyStatus(st) {
    state.status = st;
    state.download = st.download;
    const call = st.call;
    clearInterval(state.timer);
    if (call.active && call.startedAt) {
      const tick = () => ($('timer').textContent = fmt(Date.now() - call.startedAt));
      tick();
      state.timer = setInterval(tick, 1000);
    } else if (call.startedAt && call.endedAt) {
      $('timer').textContent = fmt(call.endedAt - call.startedAt);
    } else {
      $('timer').textContent = '';
    }
    setMeterState('You', st.mic.state, call.active);
    setMeterState('Them', st.system.state, call.active);
    const backlog = st.whisper.backlog || 0;
    $('backlog').hidden = backlog < 2;
    $('backlog').textContent = `${backlog} to transcribe`;
    renderBanners();
    renderStage();
  }

  // One of three screens: waiting for a call, on a call, or just after one.
  function renderStage() {
    const st = state.status;
    const s = state.settings;
    if (!st || !s) return;
    const call = st.call;
    const empty = state.qa.size === 0;
    const before = !call.active && !call.stopping && !call.startedAt; // no call yet, maybe a question asked ahead
    const idle = before && empty;
    const ended = !call.active && !before;
    document.body.classList.toggle('idle', idle);
    document.body.classList.toggle('before', before);
    document.body.classList.toggle('live', call.active);
    document.body.classList.toggle('ended', ended);
    $('home').hidden = !idle;
    $('cueZone').hidden = idle;
    $('answersEmpty').hidden = !empty || idle;
    document.body.classList.toggle('paused', !!call.paused);
    $('headTitle').textContent = call.paused ? 'Paused' : call.active ? call.title || call.app || 'Listening' : ended ? 'Ended' : 'Callaside';
    $('listeningSub').textContent = s.autoAnswer ? 'Answers land here as soon as they ask a question.' : 'Press Answer them when you need the words.';
    $('answersEmpty').querySelector('.listening-title').textContent = call.active ? 'Listening.' : 'No answers from this call.';
    $('askInput').placeholder = idle ? 'Ask something before the call' : 'Ask about this call';
    const end = $('endBtn');
    end.disabled = !!call.stopping;
    end.textContent = call.stopping ? 'Saving' : call.active ? 'End call' : before ? 'Start call' : 'New call';
    end.classList.toggle('danger', call.active);
    $('openSaved').hidden = call.active || call.stopping || !call.file;
    $('pauseBtn').hidden = !call.active;
    $('pauseBtn').textContent = call.paused ? 'Resume' : 'Pause';
    renderTranscriptPane(idle);
    renderContext();
    renderCallNotes();
    if (idle) renderHome();
  }

  // After a call: talk time, then the notes as soon as they are written.
  function renderCallNotes() {
    const st = state.status;
    const stats = st.call.stats;
    const n = state.callNotes;
    const show = !st.call.active && !st.call.stopping && (!!n || !!(stats && stats.turns));
    $('callNotes').hidden = !show;
    if (!show) return;
    $('callStats').hidden = !(stats && stats.turns);
    if (stats && stats.turns) {
      const who = stats.longest.who === 'you' ? 'You' : 'Them';
      $('callStats').textContent = `You ${stats.youShare}%, Them ${stats.themShare}%. ${stats.turns} turns. Longest: ${who}, ${fmt(stats.longest.ms)}.`;
    }
    const body = $('notesBody');
    body.replaceChildren();
    if (!n) return;
    if (n.state === 'working') {
      body.appendChild(el('p', 'notes-wait', 'Writing your notes'));
    } else if (n.state === 'error') {
      body.appendChild(el('p', 'notes-wait', n.error || 'Could not write the notes.'));
      body.appendChild(noteButton('Try again', () => api.writeNotes(st.call.id)));
    } else if (n.notes) {
      const { summary, decisions, actions, followUp } = n.notes;
      body.appendChild(el('p', 'notes-summary', summary));
      noteList(body, 'Decisions', decisions);
      noteList(
        body,
        'Action items',
        actions.map((a) => (a.owner ? `${a.owner}: ${a.task}` : a.task))
      );
      const row = el('div', 'notes-actions');
      if (followUp) {
        row.appendChild(
          noteButton('Copy follow-up email', () => {
            api.copy(followUp);
            toast('Copied.', { timeout: 2000 });
          })
        );
      }
      row.appendChild(noteButton('Open in Past calls', () => api.openLibrary()));
      body.appendChild(row);
    }
  }

  function noteList(box, title, items) {
    if (!items.length) return;
    box.appendChild(el('h3', 'notes-title', title));
    const ul = el('ul', 'notes-list');
    for (const item of items) ul.appendChild(el('li', null, item));
    box.appendChild(ul);
  }

  function noteButton(label, run) {
    const b = el('button', 'text-btn', label);
    b.type = 'button';
    b.onclick = run;
    return b;
  }

  // Which project and note this call is using. It stays in view, because the
  // wrong project gives confident wrong answers.
  function renderContext() {
    const s = state.settings;
    const has = usableProjects(s.projects).length > 0;
    $('context').hidden = false;
    $('projectWrap').hidden = !has;
    $('addProject').hidden = has;
    const select = $('projectSelect');
    fillProjects(select, s.projects, s.activeProject, [{ value: 'manage', label: 'Edit projects' }]);
    $('projectWrap').classList.toggle('on', !!select.value);
    const note = state.status.note || '';
    $('noteBtn').textContent = note || 'Add a note for this call';
    $('noteBtn').title = note;
    $('noteBtn').classList.toggle('set', !!note);
  }

  function bindContext() {
    const select = $('projectSelect');
    select.addEventListener('change', () => {
      if (select.value === 'manage') {
        select.value = state.settings.activeProject;
        api.openSettings('projects');
      } else {
        api.updateSettings({ activeProject: select.value });
      }
      select.blur();
    });
    $('addProject').onclick = () => api.openSettings('projects');
    const form = $('noteForm');
    const input = $('noteInput');
    const close = () => {
      form.hidden = true;
      $('noteBtn').hidden = false;
    };
    $('noteBtn').onclick = () => {
      input.value = state.status.note || '';
      $('noteBtn').hidden = true;
      form.hidden = false;
      input.focus();
    };
    const commit = () => {
      if (form.hidden) return;
      close();
      if (input.value.trim() !== (state.status.note || '')) api.setNote(input.value.trim());
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      commit();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  function renderTranscriptPane(idle) {
    const open = !idle && !!state.settings.showTranscript && !state.notepadOpen;
    $('notepadPane').hidden = idle || !state.notepadOpen;
    $('notepadBtn').setAttribute('aria-expanded', String(state.notepadOpen));
    $('notepadBtn').classList.toggle('on', state.notepadOpen);
    $('transcriptPane').hidden = !open;
    $('divider').hidden = !open;
    $('foot').classList.toggle('open', open);
    $('copyTranscript').hidden = !open;
    $('transcriptToggle').setAttribute('aria-expanded', String(open));
  }

  function renderHome() {
    const st = state.status;
    const s = state.settings;
    const blocked = renderChecks();
    const app = st.detect.app;
    const detecting = s.detectCalls && st.detect.state === 'on';
    $('startNow').classList.toggle('primary', !!app);
    $('startNow').textContent = app ? `Start on ${app}` : 'Start now';
    if (app) {
      $('homeTitle').textContent = `Call on ${app}.`;
      $('homeSub').textContent = 'Start when you want answers.';
    } else if (blocked) {
      $('homeTitle').textContent = 'Not ready yet.';
      $('homeSub').textContent = 'Sort out the items marked yellow.';
    } else {
      $('homeTitle').textContent = 'Waiting for a call.';
      $('homeSub').textContent = detecting ? 'A small prompt appears when one starts. You can close this.' : 'Press Start now when it begins.';
    }
  }

  function renderChecks() {
    const st = state.status;
    const s = state.settings;
    const model = state.models.find((m) => m.id === s.whisperModel);
    const speechReady = state.testMode || (model && model.downloaded);
    const folder = s.folderAccess && s.contextFolder ? basename(s.contextFolder) : '';
    const files = s.contextFiles.length ? `${s.contextFiles.length} file${s.contextFiles.length === 1 ? '' : 's'}` : '';
    const knowledge = [folder, files].filter(Boolean).join(' + ');
    const micBlocked = s.captureMic && st.micAccess === 'denied';
    const claudeMissing = st.claude.state === 'missing';
    const notesIssue = NOTES_ISSUES[st.notes];
    const rows = [
      ['Microphone', 'listening', !s.captureMic ? ['off', 'Off'] : micBlocked ? ['warn', 'Blocked in System Settings'] : ['ok', 'On']],
      // macOS has no way to ask about this permission up front. Silence during the call is the only sign.
      ['Call audio', 'listening', s.captureSystem ? ['pending', 'Confirmed once audio plays'] : ['off', 'Off']],
      ['Speech', 'listening', speechReady ? ['ok', model ? `${model.label} model` : 'Ready'] : ['warn', 'Needs a download']],
      ['Answers', 'answers', claudeMissing ? ['warn', 'Claude Code not found'] : ['ok', modelName(s.claudeModel)]],
      ['Knowledge', 'knowledge', notesIssue ? ['warn', notesIssue] : knowledge ? ['ok', knowledge] : ['off', 'None attached']],
      ['Call detection', 'listening', !s.detectCalls ? ['off', 'Off'] : st.detect.state === 'missing' ? ['warn', 'Not installed'] : ['ok', 'On']],
    ];
    const list = $('checks');
    list.replaceChildren();
    for (const [label, section, [level, value]] of rows) {
      const li = el('li');
      const b = el('button', `check ${level}`);
      b.type = 'button';
      b.title = 'Open in Settings';
      b.onclick = () => api.openSettings(section);
      b.appendChild(el('span', `lamp ${level}`));
      b.appendChild(el('span', 'check-label', label));
      b.appendChild(el('span', 'check-value', value));
      li.appendChild(b);
      list.appendChild(li);
    }
    return micBlocked || !speechReady || claudeMissing || !!notesIssue;
  }

  function setMeterState(name, s, active) {
    const shown = active || s === 'error' ? s : 'off';
    const label = { off: 'off', starting: 'starting', on: 'live', error: 'error' }[shown] || shown;
    const what = name === 'You' ? 'Microphone' : 'Call audio';
    const e = $(`state${name}`);
    e.classList.toggle('problem', shown === 'error');
    e.parentElement.title = `${what}: ${label}`;
    if (!active) $(`meter${name}`).style.transform = 'scaleX(0)';
  }

  function onLevel({ source, rms }) {
    // Map RMS (0..~0.3) to a 0..1 bar on a soft log scale.
    const v = Math.max(0, Math.min(1, (Math.log10(Math.max(rms, 1e-4)) + 3.6) / 3));
    $(source === 'you' ? 'meterYou' : 'meterThem').style.transform = `scaleX(${v.toFixed(3)})`;
  }

  function renderBanners() {
    const st = state.status;
    const s = state.settings;
    if (!st || !s) return;
    const box = $('banners');
    box.replaceChildren();
    const add = (level, text, actions = []) => {
      const b = el('div', `banner ${level}`);
      b.appendChild(el('span', 'banner-text', text));
      for (const [label, run] of actions) {
        const btn = el('button', 'btn small', label);
        btn.type = 'button';
        btn.onclick = run;
        b.appendChild(btn);
      }
      box.appendChild(b);
      return b;
    };
    const model = state.models.find((m) => m.id === s.whisperModel);
    if (!state.testMode && model && !model.downloaded) {
      const d = state.download;
      if (d && d.id === model.id) {
        const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
        const b = add('info', `Downloading the ${model.label.toLowerCase()} speech model… ${pct}%`, [['Cancel', () => api.cancelDownload()]]);
        const bar = el('div', 'progress');
        const fill = el('span');
        fill.style.transform = `scaleX(${pct / 100})`;
        bar.appendChild(fill);
        b.appendChild(bar);
      } else {
        add('info', `Download the ${model.label.toLowerCase()} speech model (${model.size}) to start. It runs on this Mac.`, [
          ['Download', () => startDownload(model.id)],
        ]);
      }
    }
    if (st.claude.state === 'missing') {
      add('warn', 'Claude Code was not found. Install it, run claude in Terminal once to sign in, then reopen this app.');
    } else if (st.claude.state === 'error' && st.claude.error) {
      add('warn', st.claude.error);
    }
    if (st.whisper.state === 'error' && st.whisper.error) add('error', st.whisper.error);
    if (st.system.state === 'error' && st.system.error) add('warn', `Call audio: ${st.system.error}`);
    else if (st.system.hint === 'silent' && st.call.active) {
      add(
        'warn',
        'No call audio yet. If the other side is talking, open System Settings > Privacy & Security > Screen & System Audio Recording and allow Callaside under System Audio Recording Only.'
      );
    }
    if (st.mic.state === 'error' && st.mic.error) add('warn', `Microphone: ${st.mic.error}`);
    if (st.call.active && st.call.paused) add('info', 'Paused. Nothing is being transcribed.');
    if (st.call.active && s.consentReminder && !state.noticeDone) {
      const done = () => {
        state.noticeDone = true;
        renderBanners();
      };
      add('info', "Let everyone know you're transcribing. Some places require it.", [
        [
          'Copy heads-up',
          () => {
            api.copy(HEADS_UP);
            toast('Copied. Paste it in the meeting chat.', { timeout: 3000 });
            done();
          },
        ],
        ['Done', done],
      ]);
    }
    if (st.call.active && NOTES_ISSUES[st.notes]) {
      add('warn', 'Answers are not using your notes folder right now.', [['Settings', () => api.openSettings('knowledge')]]);
    }
    if ((st.whisper.backlog || 0) > 6) {
      add('warn', 'Transcription is falling behind. A faster speech model will help.', [['Settings', () => api.openSettings('listening')]]);
    }
  }

  async function startDownload(id) {
    const r = await api.downloadModel(id);
    if (!r.ok) toast(r.error || 'Download failed.', { level: 'error' });
  }

  // ---------- microphone ----------

  async function startMic(deviceId) {
    try {
      const ok = await api.ensureMicAccess();
      if (!ok) throw new Error('Access is off. Allow Callaside in System Settings > Privacy & Security > Microphone.');
      state.mic = await window.MicCapture.start(deviceId, (buf) => api.micPcm(buf));
      api.micState({ state: 'on' });
    } catch (err) {
      api.micState({ state: 'error', error: err.message || String(err) });
    }
  }

  function stopMic() {
    if (state.mic) {
      state.mic.stop();
      state.mic = null;
    }
  }

  // ---------- composer ----------

  function renderChips() {
    const box = $('chips');
    for (const [kind, label, tip] of QUICK) {
      const b = el('button', 'chip', label);
      b.type = 'button';
      b.title = tip;
      b.onclick = () => api.ask('', kind);
      box.appendChild(b);
    }
  }

  function bindComposer() {
    const input = $('askInput');
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('askForm').requestSubmit();
      }
    });
    $('askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      api.ask(text, 'custom');
      input.value = '';
      grow();
    });
  }

  // ---------- layout ----------

  function bindDivider() {
    const pane = $('transcriptPane');
    const stage = $('stage');
    let saved = null;
    try {
      saved = Number(localStorage.getItem('logShare'));
    } catch {}
    const apply = (f) => (pane.style.flexBasis = `${Math.round(f * 100)}%`);
    if (saved > 0.1 && saved < 0.8) apply(saved);
    const div = $('divider');
    div.addEventListener('pointerdown', (e) => {
      div.setPointerCapture(e.pointerId);
      const rect = stage.getBoundingClientRect();
      const move = (ev) => {
        const f = Math.min(0.7, Math.max(0.12, (rect.bottom - ev.clientY) / rect.height));
        apply(f);
        try {
          localStorage.setItem('logShare', String(f));
        } catch {}
      };
      const up = () => {
        div.removeEventListener('pointermove', move);
        div.removeEventListener('pointerup', up);
      };
      div.addEventListener('pointermove', move);
      div.addEventListener('pointerup', up);
    });
    const box = $('transcript');
    box.addEventListener('scroll', () => {
      if (nearBottom(box)) $('jumpLive').hidden = true;
    });
    $('jumpLive').onclick = () => {
      scrollBottom(box);
      $('jumpLive').hidden = true;
    };
  }

  // ---------- wiring ----------

  function bind() {
    bindComposer();
    bindDivider();
    bindContext();
    const start = async () => {
      const r = await api.startCall();
      if (!r.ok) toast(r.error || 'Could not start.', { level: 'error', timeout: 9000 });
    };
    $('startNow').onclick = start;
    $('endBtn').onclick = () => (state.status.call.active ? api.stopCall() : start());
    $('openSaved').onclick = () => api.open('transcript');
    $('pauseBtn').onclick = () => api.pauseCall(!state.status.call.paused);
    $('hideBtn').onclick = () => api.hidePanel();
    $('minBtn').onclick = () => api.minimizePanel(!document.body.classList.contains('minimized'));
    $('libraryBtn').onclick = () => api.openLibrary();
    let notepadTimer = null;
    $('notepad').addEventListener('input', () => {
      clearTimeout(notepadTimer);
      notepadTimer = setTimeout(() => api.setNotepad($('notepad').value), 500);
    });
    $('notepadBtn').onclick = () => {
      state.notepadOpen = !state.notepadOpen;
      renderStage();
      if (state.notepadOpen) $('notepad').focus();
    };
    $('transcriptToggle').onclick = () => {
      // Coming from the notepad, a transcript that was already on just reappears.
      if (state.notepadOpen) {
        state.notepadOpen = false;
        if (state.settings.showTranscript) return renderStage();
      }
      const next = !state.settings.showTranscript;
      state.settings.showTranscript = next;
      api.updateSettings({ showTranscript: next });
      renderStage();
      if (next) scrollBottom($('transcript'));
    };
    $('copyTranscript').onclick = () => {
      api.copy(transcriptText());
      toast('Transcript copied.', { timeout: 2000 });
    };
    $('settingsBtn').onclick = () => api.openSettings();
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        api.openSettings();
      }
    });

    api.on('status', applyStatus);
    api.on('level', onLevel);
    api.on('transcript:add', ({ line, beforeId }) => addLine(line, beforeId));
    api.on('transcript:remove', removeLine);
    api.on('qa:update', (qa) => {
      upsertQa(qa);
      if (document.body.classList.contains('minimized')) document.body.classList.add('answer-waiting');
    });
    api.on('panel:minimized', (on) => {
      document.body.classList.toggle('minimized', on);
      document.body.classList.remove('answer-waiting');
      $('minBtn').title = on ? 'Back to full size' : 'Minimize to a small bar';
      $('minBtn').setAttribute('aria-label', on ? 'Restore panel' : 'Minimize panel');
    });
    api.on('reset', () => {
      state.noticeDone = false;
      state.callNotes = null;
      state.notepadOpen = false;
      $('notepad').value = '';
      clearAll();
    });
    api.on('notes:update', (update) => {
      if (update.id !== state.status.call.id) return;
      state.callNotes = update;
      renderCallNotes();
    });
    api.on('settings', (s) => {
      state.settings = s;
      renderBanners();
      renderStage();
    });
    api.on('models', (list) => {
      state.models = list;
      renderBanners();
      renderStage();
    });
    api.on('model:progress', (p) => {
      state.download = p.done ? null : p;
      renderBanners();
    });
    api.on('toast', ({ level, message }) => toast(message, { level }));
    api.on('call:started', ({ captureMic, micDeviceId }) => {
      if (captureMic) startMic(micDeviceId);
    });
    api.on('call:stopping', () => {
      stopMic();
      api.micState({ state: 'off' });
    });
    api.on('focus-input', () => $('askInput').focus());
  }

  async function init() {
    const s = await api.getState();
    state.settings = s.settings;
    state.models = s.models;
    state.testMode = s.testMode;
    document.body.classList.add(`platform-${s.platform}`);
    renderChips();
    for (const l of s.lines) addLine(l, null);
    for (const q of s.qa) upsertQa(q);
    applyStatus(s.status);
    bind();
  }

  init();
})();

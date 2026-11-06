'use strict';

(() => {
  const api = window.quickaside;
  const $ = (id) => document.getElementById(id);
  const { el, toast } = window.ui;

  const state = { calls: [], current: null, record: null, query: '', templates: [], writing: new Set() };

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  }

  function when(ms) {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function minutes(call) {
    if (!call.endedAt) return '';
    return `${Math.max(1, Math.round((call.endedAt - call.startedAt) / 60000))} min`;
  }

  function textButton(label, run, cls = '') {
    const b = el('button', `text-btn ${cls}`.trim(), label);
    b.type = 'button';
    b.onclick = run;
    return b;
  }

  // ---------- the list ----------

  async function refreshList() {
    const seq = (refreshList.seq = (refreshList.seq || 0) + 1);
    const calls = await api.listCalls(state.query);
    if (seq !== refreshList.seq) return;
    state.calls = calls;
    renderList();
    if (!state.current && calls.length) select(calls[0].id);
    if (!calls.length) {
      state.current = null;
      state.record = null;
      renderCall();
    }
  }

  function renderList() {
    const list = $('list');
    list.replaceChildren();
    for (const c of state.calls) {
      const li = el('li');
      const b = el('button', 'item');
      b.type = 'button';
      if (c.id === state.current) b.setAttribute('aria-current', 'true');
      b.onclick = () => select(c.id);
      b.appendChild(el('span', 'item-title', c.title));
      b.appendChild(el('span', 'item-meta', [when(c.startedAt), minutes(c)].filter(Boolean).join(', ')));
      if (c.summary) b.appendChild(el('span', 'item-meta', c.summary));
      li.appendChild(b);
      list.appendChild(li);
    }
    list.hidden = !state.calls.length;
    $('listEmpty').hidden = state.calls.length > 0;
    $('listEmpty').textContent = state.query ? 'No calls match that.' : 'Your calls will show up here.';
  }

  async function select(id) {
    state.current = id;
    state.record = await api.getCall(id);
    renderList();
    renderCall();
  }

  // ---------- one call ----------

  function renderCall() {
    const box = $('call');
    box.replaceChildren();
    box.scrollTop = 0;
    const r = state.record;
    if (!r) {
      box.appendChild(el('p', 'nothing', state.query ? 'Nothing to show.' : 'Pick a call.'));
      return;
    }
    const head = el('div', 'call-head');
    const words = el('div');
    words.appendChild(el('h1', null, r.title || r.project || r.app || 'Call'));
    const with_ = r.attendees && r.attendees.length ? `With ${r.attendees.join(', ')}` : '';
    words.appendChild(el('p', 'call-meta', [when(r.startedAt), minutes(r), r.app, r.project, with_].filter(Boolean).join(', ')));
    head.appendChild(words);
    const tools = el('div', 'call-tools');
    if (r.file) tools.appendChild(textButton('Show file', () => api.revealCall(r.id)));
    tools.appendChild(
      textButton(
        'Delete',
        async () => {
          if (!(await api.deleteCall(r.id))) return;
          state.current = null;
          state.record = null;
          await refreshList();
          renderCall();
        },
        'delete'
      )
    );
    head.appendChild(tools);
    box.appendChild(head);
    if (r.stats && r.stats.turns) box.appendChild(talkBlock(r.stats));
    box.appendChild(notesBlock(r));
    box.appendChild(notepadBlock(r));
    if (r.qa && r.qa.some((q) => q.answer)) box.appendChild(answersBlock(r));
    box.appendChild(transcriptBlock(r));
  }

  function talkBlock(stats) {
    const talk = el('div', 'talk');
    const bar = el('div', 'talk-bar');
    const you = el('span', 'talk-you');
    you.style.flexGrow = String(stats.youShare);
    const them = el('span', 'talk-them');
    them.style.flexGrow = String(stats.themShare);
    bar.appendChild(you);
    bar.appendChild(them);
    talk.appendChild(bar);
    const who = stats.longest.who === 'you' ? 'You' : 'Them';
    const asked = stats.theirQuestions ? ` ${stats.theirQuestions} questions from them.` : '';
    talk.appendChild(el('span', 'talk-text', `You ${stats.youShare}%, Them ${stats.themShare}%. ${stats.turns} turns. Longest: ${who}, ${fmt(stats.longest.ms)}.${asked}`));
    return talk;
  }

  function notesBlock(r) {
    const block = el('section', 'block');
    const head = el('div', 'block-head');
    head.appendChild(el('h2', null, 'Notes'));
    const tools = el('div', 'block-tools');
    const style = el('select');
    style.setAttribute('aria-label', 'Style of notes');
    for (const t of state.templates) {
      const o = el('option', null, t.label);
      o.value = t.id;
      style.appendChild(o);
    }
    style.value = r.template;
    tools.appendChild(style);
    const write = el('button', 'btn small', r.notes ? 'Write again' : 'Write notes');
    write.type = 'button';
    write.disabled = state.writing.has(r.id);
    write.onclick = async () => {
      const result = await api.writeNotes(r.id, style.value);
      if (!result.ok) toast(result.error, { level: 'error' });
    };
    tools.appendChild(write);
    head.appendChild(tools);
    block.appendChild(head);
    if (state.writing.has(r.id)) {
      block.appendChild(el('p', 'faint', 'Writing your notes'));
      return block;
    }
    const n = r.notes;
    if (!n) {
      block.appendChild(el('p', 'faint', 'No notes yet.'));
      return block;
    }
    block.appendChild(el('p', null, n.summary));
    const section = (title, items) => {
      if (!items.length) return;
      block.appendChild(el('h3', null, title));
      const ul = el('ul');
      for (const item of items) ul.appendChild(el('li', null, item));
      block.appendChild(ul);
    };
    section('Decisions', n.decisions);
    section(
      'Action items',
      n.actions.map((a) => (a.owner ? `${a.owner}: ${a.task}` : a.task))
    );
    if (n.followUp) {
      block.appendChild(el('h3', null, 'Follow-up email'));
      block.appendChild(el('p', 'email', n.followUp));
    }
    const row = el('div', 'block-tools');
    row.style.marginTop = '12px';
    row.appendChild(
      textButton('Copy notes', () => {
        api.copyCallNotes(r.id);
        toast('Copied.', { timeout: 2000 });
      })
    );
    if (n.followUp) {
      row.appendChild(
        textButton('Copy email', () => {
          api.copy(n.followUp);
          toast('Copied.', { timeout: 2000 });
        })
      );
    }
    block.appendChild(row);
    return block;
  }

  function notepadBlock(r) {
    const block = el('section', 'block');
    block.appendChild(el('h2', null, 'My notes'));
    block.lastChild.style.marginBottom = '10px';
    const box = el('textarea');
    box.value = r.notepad || '';
    box.placeholder = 'Anything you want to remember.';
    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      r.notepad = box.value;
      timer = setTimeout(() => api.saveCallNotepad(r.id, box.value), 600);
    });
    block.appendChild(box);
    return block;
  }

  function answersBlock(r) {
    const block = el('section', 'block');
    block.appendChild(el('h2', null, 'Answers during the call'));
    for (const q of r.qa.filter((x) => x.answer)) {
      const item = el('div', 'qa');
      item.appendChild(el('div', 'qa-q', q.question));
      const a = el('div', 'md');
      a.innerHTML = window.renderMarkdown(q.answer);
      item.appendChild(a);
      block.appendChild(item);
    }
    return block;
  }

  function transcriptBlock(r) {
    const block = el('section', 'block');
    const h = el('h2', null, 'Transcript');
    h.style.marginBottom = '10px';
    block.appendChild(h);
    if (!r.lines || !r.lines.length) {
      block.appendChild(el('p', 'faint', 'Nothing was transcribed.'));
      return block;
    }
    for (const l of r.lines) {
      const row = el('div', `line ${l.source}`);
      row.appendChild(el('span', 't', fmt(l.startMs)));
      row.appendChild(el('span', 'who', l.source === 'you' ? 'You' : 'Them'));
      row.appendChild(el('span', 'text', l.text));
      block.appendChild(row);
    }
    return block;
  }

  // ---------- asking across calls ----------

  async function ask(question) {
    const box = $('askResult');
    box.hidden = false;
    $('askBtn').disabled = true;
    $('askFrom').replaceChildren();
    $('askAnswer').textContent = 'Looking through your calls';
    const r = await api.askCalls(question);
    $('askBtn').disabled = false;
    if (!r.ok) {
      $('askAnswer').textContent = r.error || 'Could not answer that.';
      return;
    }
    $('askAnswer').innerHTML = window.renderMarkdown(r.answer);
    const known = new Map(state.calls.map((c) => [c.id, c]));
    for (const id of r.calls) {
      const c = known.get(id);
      if (!c) continue;
      const b = el('button', 'btn small', `${c.title}, ${when(c.startedAt)}`);
      b.type = 'button';
      b.onclick = () => select(id);
      $('askFrom').appendChild(b);
    }
  }

  // ---------- wiring ----------

  async function init() {
    state.templates = await api.noteTemplates();
    let timer = null;
    $('search').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.query = $('search').value;
        refreshList();
      }, 150);
    });
    $('askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('askInput').value.trim();
      if (q) ask(q);
    });
    $('askClose').onclick = () => {
      api.cancelAsk();
      $('askResult').hidden = true;
    };
    api.on('calls:changed', async () => {
      await refreshList();
      if (state.current) {
        state.record = await api.getCall(state.current);
        if (!document.activeElement || document.activeElement.tagName !== 'TEXTAREA') renderCall();
      }
    });
    api.on('notes:update', async ({ id, state: step, error }) => {
      if (step === 'working') state.writing.add(id);
      else state.writing.delete(id);
      if (step === 'error') toast(error || 'Could not write the notes.', { level: 'error' });
      if (id === state.current) {
        state.record = await api.getCall(id);
        renderCall();
      }
    });
    api.on('library:select', select);
    const wanted = new URLSearchParams(location.search).get('call');
    if (wanted) state.current = wanted;
    await refreshList();
    if (wanted) await select(wanted);
    if (!state.calls.length) renderCall();
  }

  init();
})();

'use strict';

// The Copy buttons, and the demo in the first screen. The page works without either:
// with no script it shows a picture instead. Nothing here leaves the page.

for (const button of document.querySelectorAll('.copy')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(code);
      button.textContent = 'Press Cmd+C';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1800);
  });
}

// ---------- the demo: the real app's layout, with made-up clients ----------

const SCRIPT = [
  { at: 1500, q: 'Where does our pilot stand right now?', a: 'The pilot is agreed for one site, two weeks, at $2,000. It starts Monday.' },
  { at: 10000, q: 'What results have you seen so far?', a: "We don't have results yet, because the pilot starts Monday. Once it's running, I'll share what we see at the site." },
];

const QUICK = [
  ['Answer them', 'Answer them', "We don't have results yet, because the pilot starts Monday."],
  ['Next move', 'Next move', 'Offer to send the pilot plan today, and ask who signs off on Monday.'],
  ['Summary', 'Summary', 'Harbor Clinic wants to know where the pilot stands. It starts Monday at one site, so there are no results yet.'],
  ['Action items', 'Action items', 'You: send the pilot plan today. Tom: confirm who signs off.'],
];

const CALLS = [
  { title: 'Harbor Clinic', when: 'Today, 22 min', summary: 'Pilot agreed for one site. It starts Monday.', actions: ['You: send the pilot plan', 'Tom: confirm who signs off'] },
  { title: 'Acme Dental', when: 'Mon, 41 min', summary: 'First call. They want fewer missed calls at the front desk.', actions: ['You: send pricing'] },
  { title: 'Northwind Labs', when: 'Fri, 18 min', summary: 'Check-in. Happy so far, and asked about a second site.', actions: ['You: quote a second site'] },
];

const PROJECTS = [
  { name: 'Harbor Clinic', brief: 'Dental group, 3 sites. Pilot agreed for one site, two weeks, $2,000. Starts Monday.', active: true },
  { name: 'Acme Dental', brief: 'First call done. Cares about missed calls at the front desk.' },
];

const SWITCHES = [
  ['Answer every question they ask', true],
  ['Offer to start when a call begins', true],
  ['Open at login', false],
  ['Use my calendar', false],
  ['Save each call', true],
];

const NAV = [
  ['now', 'Now'],
  ['calls', 'Past calls'],
  ['projects', 'Projects'],
  ['settings', 'Settings'],
];

function startDemo(root) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = matchMedia('(max-width: 640px)').matches;
  const state = { view: 'now', rail: !small, phase: 'idle', qa: [], seconds: 0, last: '', picked: 0, projects: [...PROJECTS], found: false, switches: SWITCHES.map((s) => s[1]), touched: false };
  let timers = [];

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (cls, text, run) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.touched = true;
      run();
    });
    return b;
  };
  const later = (ms, run) => timers.push(setTimeout(run, still ? Math.min(ms, 300) : ms));
  const stopTimers = () => {
    timers.forEach(clearTimeout);
    clearInterval(state.clock);
    timers = [];
  };
  const clock = () => {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(state.seconds / 60))}:${p(state.seconds % 60)}`;
  };

  // ---------- the frame ----------

  const app = el('div', 'app');
  const head = el('div', 'app-head');
  const lights = el('span', 'lights');
  lights.setAttribute('aria-hidden', 'true');
  lights.append(el('i'), el('i'), el('i'));
  const railBtn = button('app-icon', '', () => {
    state.rail = !state.rail;
    if (!state.rail) state.view = 'now';
    draw();
  });
  railBtn.setAttribute('aria-label', 'Show or hide the sidebar');
  railBtn.append(el('span', 'rail-glyph'));
  const tally = el('span', 'tally');
  const timer = el('span', 'app-timer');
  const title = el('span', 'app-title');
  const meters = el('span', 'app-meters');
  meters.setAttribute('aria-hidden', 'true');
  for (const who of ['You', 'Them']) {
    const m = el('span', `meter ${who.toLowerCase()}`, who);
    m.append(el('i'));
    meters.append(m);
  }
  head.append(lights, railBtn, tally, timer, title, meters);
  const body = el('div', 'app-body');
  const rail = el('nav', 'app-rail');
  rail.setAttribute('aria-label', 'Demo');
  const navButtons = NAV.map(([id, label]) => {
    const b = button('rail-item', label, () => {
      state.view = id;
      draw();
    });
    b.dataset.view = id;
    rail.append(b);
    return b;
  });
  const view = el('div', 'app-view');
  body.append(rail, view);
  app.append(head, body);
  root.replaceChildren(app);

  // ---------- Now ----------

  function say(q, a, kind) {
    const item = { q, a, shown: still ? a : '', kind };
    state.qa.unshift(item);
    draw();
    if (still) return;
    const words = a.split(' ');
    let i = 0;
    const next = () => {
      if (!state.qa.includes(item)) return;
      i += 1;
      item.shown = words.slice(0, i).join(' ');
      const text = view.querySelector('.cue.latest .cue-a');
      if (state.qa[0] === item && text) text.textContent = item.shown;
      if (i < words.length) later(55, next);
    };
    later(700, next);
  }

  function startCall() {
    stopTimers();
    Object.assign(state, { phase: 'live', qa: [], seconds: 0, last: '', view: 'now', rail: false });
    state.clock = setInterval(() => {
      state.seconds += 1;
      timer.textContent = clock();
    }, 1000);
    for (const { at, q, a } of SCRIPT) {
      later(at, () => {
        state.last = `Them: ${q}`;
        say(q, a, 'They asked');
      });
    }
    draw();
  }

  function endCall() {
    stopTimers();
    state.phase = 'ended';
    draw();
  }

  function reset() {
    stopTimers();
    Object.assign(state, { phase: 'idle', qa: [], seconds: 0, last: '', rail: !small });
    draw();
  }

  function cue(item, latest) {
    const box = el('article', latest ? 'cue latest' : 'cue');
    if (item.kind) box.append(el('p', 'cue-kind', item.kind));
    box.append(el('p', 'cue-q', item.q));
    box.append(el('p', 'cue-a', latest ? item.shown : item.a));
    return box;
  }

  function nowLive() {
    const context = el('div', 'app-context');
    context.append(el('span', 'chip-on', 'Harbor Clinic'), el('span', 'faint', 'Add a note for this call'));
    const cues = el('div', 'cues');
    if (!state.qa.length) {
      cues.append(el('p', 'big', 'Listening.'), el('p', 'muted', 'Answers land here as soon as they ask a question.'));
    }
    state.qa.forEach((item, i) => cues.append(cue(item, i === 0)));
    const keys = el('div', 'keys');
    for (const [label, q, a] of QUICK) keys.append(button('key', label, () => say(q, a, '')));
    const ask = el('input', 'ask');
    ask.placeholder = 'Ask about this call';
    ask.setAttribute('aria-label', 'Ask about this call');
    ask.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !ask.value.trim()) return;
      state.touched = true;
      say(ask.value.trim(), 'This demo only knows a few lines. In the app, Claude answers from the call and your notes.', 'You asked');
    });
    const foot = el('div', 'app-foot');
    foot.append(el('span', 'foot-last', state.last || 'Transcript'), button('btn-sm', 'End call', endCall));
    view.append(context, cues, keys, ask, foot);
  }

  function nowIdle() {
    const home = el('div', 'home');
    home.append(el('p', 'big', 'Waiting for a call.'), el('p', 'muted', 'It offers to start when your call app does.'));
    home.append(button('start', 'Start a sample call', startCall));
    home.append(el('p', 'label', 'Last call'));
    const last = button('row', '', () => {
      state.view = 'calls';
      draw();
    });
    last.append(el('strong', null, CALLS[0].title), el('span', 'faint', CALLS[0].when), el('span', 'muted', CALLS[0].summary));
    home.append(last);
    view.append(home);
  }

  function nowEnded() {
    const box = el('div', 'home');
    box.append(el('p', 'big', 'Notes are ready.'), el('p', 'muted', 'You 42%, Them 58%. Written a few seconds after the call.'));
    box.append(el('p', 'note', 'Harbor Clinic wants to know where the pilot stands. It starts Monday at one site, so there are no results yet.'));
    box.append(el('p', 'label', 'Action items'));
    const list = el('ul', 'list');
    for (const item of CALLS[0].actions) list.append(el('li', null, item));
    box.append(list);
    const row = el('div', 'row-actions');
    row.append(button('btn-sm', 'New call', reset));
    box.append(row);
    view.append(box);
  }

  // ---------- the other pages ----------

  function calls() {
    const page = el('div', 'split');
    const list = el('div', 'split-list');
    CALLS.forEach((c, i) => {
      const b = button(`row${i === state.picked ? ' on' : ''}`, '', () => {
        state.picked = i;
        draw();
      });
      b.append(el('strong', null, c.title), el('span', 'faint', c.when));
      list.append(b);
    });
    const c = CALLS[state.picked];
    const detail = el('div', 'split-detail');
    detail.append(el('p', 'big small', c.title), el('p', 'faint', c.when), el('p', 'note', c.summary), el('p', 'label', 'Action items'));
    const items = el('ul', 'list');
    for (const item of c.actions) items.append(el('li', null, item));
    detail.append(items);
    page.append(list, detail);
    view.append(page);
  }

  function projects() {
    const page = el('div', 'page');
    const top = el('div', 'page-top');
    top.append(el('p', 'big small', 'Projects'));
    const find = button('start small', state.found ? 'Up to date' : 'Find my projects', () => {
      if (state.found) return;
      find.textContent = 'Reading';
      later(1100, () => {
        state.found = true;
        state.projects = [...state.projects, { name: 'Northwind Labs', brief: 'Check-in done. Asked about a second site.', fresh: true }];
        draw();
      });
    });
    top.append(find);
    page.append(top, el('p', 'muted', "Optional. A project keeps one client's facts apart from the others."));
    for (const p of state.projects) {
      const row = el('div', `project${p.fresh ? ' fresh' : ''}`);
      const name = el('p', 'project-name', p.name);
      if (p.active) name.append(el('span', 'in-use', 'In use'));
      row.append(name, el('p', 'muted', p.brief));
      page.append(row);
    }
    if (state.found) page.append(el('p', 'faint', 'Added 1 project. Used 6 Claude Code memories and 2 past calls.'));
    view.append(page);
  }

  function settings() {
    const page = el('div', 'page');
    page.append(el('p', 'big small', 'Settings'), el('p', 'label', 'Calls'));
    SWITCHES.forEach(([label], i) => {
      const row = el('div', 'set');
      row.append(el('span', null, label));
      const toggle = button(`switch${state.switches[i] ? ' on' : ''}`, '', () => {
        state.switches[i] = !state.switches[i];
        draw();
      });
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(state.switches[i]));
      toggle.setAttribute('aria-label', label);
      row.append(toggle);
      page.append(row);
    });
    page.append(el('p', 'faint', 'Everything else has a good default.'));
    view.append(page);
  }

  // ---------- drawing ----------

  function draw() {
    const live = state.phase === 'live';
    app.dataset.shape = state.rail ? 'wide' : 'panel';
    app.classList.toggle('live', live);
    tally.hidden = !live;
    timer.textContent = live || state.phase === 'ended' ? clock() : '';
    const names = { calls: 'Past calls', projects: 'Projects', settings: 'Settings' };
    title.textContent = names[state.view] || (live ? 'Listening' : state.phase === 'ended' ? 'Ended' : 'Quickaside');
    meters.hidden = !live;
    for (const b of navButtons) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    view.replaceChildren();
    if (state.view === 'calls') calls();
    else if (state.view === 'projects') projects();
    else if (state.view === 'settings') settings();
    else if (live) nowLive();
    else if (state.phase === 'ended') nowEnded();
    else nowIdle();
  }

  draw();

  // It plays by itself once, unless someone got there first or asked for less motion.
  if (!still) {
    const watch = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      watch.disconnect();
      setTimeout(() => {
        if (!state.touched && state.phase === 'idle') startCall();
      }, 1400);
    }, { threshold: 0.4 });
    watch.observe(app);
  }
}

const demoRoot = document.getElementById('demo');
if (demoRoot) startDemo(demoRoot);

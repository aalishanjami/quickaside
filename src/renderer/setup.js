'use strict';

(() => {
  const api = window.quickaside;
  const $ = (id) => document.getElementById(id);

  const STEPS = ['welcome', 'claude', 'access'];
  const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

  const state = { step: 0, settings: null, status: null, models: [], download: null, claudeReady: false, micOk: false, audioOk: false };

  function lamp(id, level) {
    $(id).className = `lamp ${level}`;
  }

  // ---------- moving between steps ----------

  function canContinue() {
    switch (STEPS[state.step]) {
      case 'welcome':
        return $('consent').checked;
      case 'claude':
        return state.claudeReady;
      default:
        return true;
    }
  }

  function renderNav() {
    const name = STEPS[state.step];
    for (const s of document.querySelectorAll('[data-step]')) s.hidden = s.dataset.step !== name;
    [...$('steps').children].forEach((li, i) => li.classList.toggle('done', i <= state.step));
    $('back').hidden = state.step === 0;
    const last = state.step === STEPS.length - 1;
    $('next').textContent = last ? 'Finish' : 'Continue';
    $('next').disabled = !canContinue();
  }

  function go(step) {
    state.step = step;
    renderNav();
    if (STEPS[step] === 'claude') checkClaude();
    if (STEPS[step] === 'access') renderAccess();
  }

  function next() {
    if (state.step === STEPS.length - 1) return api.setupFinish();
    if (state.step === 0) download(); // it takes minutes, so it runs behind the other steps
    go(state.step + 1);
  }

  // ---------- Claude Code ----------

  async function checkClaude() {
    state.claudeReady = false;
    lamp('claudeLamp', 'starting');
    $('claudeStatus').textContent = 'Checking';
    $('claudeHelp').hidden = true;
    renderNav();
    const r = await api.setupClaude();
    if (r.state === 'ready') {
      state.claudeReady = true;
      lamp('claudeLamp', 'ok');
      $('claudeStatus').textContent = r.version ? `Claude Code ${r.version} is ready` : 'Claude Code is ready';
    } else if (r.state === 'missing') {
      lamp('claudeLamp', 'warn');
      $('claudeStatus').textContent = 'Claude Code is not installed';
      showClaudeHelp('Open Terminal and run this, then run claude once to sign in. You need a Claude plan.', INSTALL);
    } else {
      lamp('claudeLamp', 'warn');
      $('claudeStatus').textContent = 'Claude Code could not answer';
      showClaudeHelp(r.error || 'Open Terminal, run this and sign in, then check again.', 'claude');
    }
    renderNav();
  }

  function showClaudeHelp(text, command) {
    $('claudeHelpText').textContent = text;
    $('claudeCommand').textContent = command;
    $('claudeHelp').hidden = false;
  }

  // ---------- speech model ----------

  function model() {
    return state.models.find((m) => m.id === state.settings.whisperModel);
  }

  function renderModel() {
    const m = model();
    if (!m) return;
    const d = state.download;
    if (m.downloaded) $('modelLine').textContent = state.started ? 'Speech model ready' : '';
    else if (d && d.id === m.id) {
      const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
      $('modelLine').textContent = `Speech model ${pct}%`;
    }
  }

  async function download() {
    const m = model();
    if (!m || m.downloaded || state.download) return;
    state.started = true;
    $('modelRetry').hidden = true;
    $('modelLine').textContent = 'Speech model starting';
    const r = await api.downloadModel(m.id);
    if (r.ok) return;
    $('modelLine').textContent = 'The speech model did not download.';
    $('modelRetry').hidden = false;
  }

  // ---------- permissions ----------

  function renderAccess() {
    const access = state.status && state.status.micAccess;
    state.micOk = state.micOk || access === 'granted';
    lamp('micLamp', state.micOk ? 'ok' : access === 'denied' ? 'warn' : 'pending');
    $('micAllow').hidden = state.micOk;
    if (state.micOk) $('micStatus').textContent = 'Allowed';
  }

  async function allowMic() {
    state.micOk = await api.ensureMicAccess();
    renderAccess();
    if (!state.micOk) {
      lamp('micLamp', 'warn');
      $('micStatus').textContent = 'Blocked. Turn on the app in System Settings.';
      $('micSettings').hidden = false;
    }
  }

  // A quiet tone, so the test has something to hear.
  function playTone(seconds) {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.04;
    osc.frequency.value = 660;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + seconds);
    osc.onended = () => ctx.close();
  }

  async function testAudio() {
    $('audioTest').disabled = true;
    lamp('audioLamp', 'starting');
    $('audioStatus').textContent = 'Listening for the tone';
    playTone(2.6);
    const r = await api.setupAudio();
    $('audioTest').disabled = false;
    state.audioOk = r.ok;
    lamp('audioLamp', r.ok ? 'ok' : 'warn');
    $('audioTest').textContent = 'Test again';
    $('audioTest').hidden = r.ok;
    $('audioSettings').hidden = r.ok;
    $('audioStatus').textContent = r.ok
      ? 'Working'
      : r.error || 'Nothing heard. Allow the prompt and test again, or turn on the app under System Audio Recording Only.';
  }

  // ---------- wiring ----------

  function bind() {
    $('consent').addEventListener('change', renderNav);
    $('next').onclick = next;
    $('back').onclick = () => go(state.step - 1);
    $('claudeRetry').onclick = checkClaude;
    $('copyCommand').onclick = () => {
      api.copy($('claudeCommand').textContent);
      $('copyCommand').textContent = 'Copied';
      setTimeout(() => ($('copyCommand').textContent = 'Copy'), 1200);
    };
    $('modelRetry').onclick = download;
    $('micAllow').onclick = allowMic;
    $('micSettings').onclick = () => api.setupPrivacy('microphone');
    $('audioTest').onclick = testAudio;
    $('audioSettings').onclick = () => api.setupPrivacy('call-audio');
    api.on('status', (st) => {
      state.status = st;
      state.download = st.download;
      renderModel();
      if (STEPS[state.step] === 'access') renderAccess();
    });
    api.on('models', (list) => {
      state.models = list;
      renderModel();
    });
    api.on('model:progress', (p) => {
      state.download = p.done ? null : p;
      renderModel();
    });
    api.on('settings', (s) => {
      state.settings = s;
    });
  }

  async function init() {
    const s = await api.getState();
    state.settings = s.settings;
    state.status = s.status;
    state.models = s.models;
    state.download = s.status.download;
    $('steps').replaceChildren(...STEPS.map(() => document.createElement('li')));
    bind();
    go(0);
  }

  init();
})();

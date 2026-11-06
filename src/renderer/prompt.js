'use strict';

(() => {
  const api = window.quickaside;
  const $ = (id) => document.getElementById(id);
  const BROWSERS = new Set(['Chrome', 'Safari', 'Arc', 'Brave', 'Edge', 'Firefox', 'Opera']);

  function render(s) {
    const has = window.ui.usableProjects(s.projects).length > 0;
    $('sub').hidden = has;
    $('pick').hidden = !has;
    window.ui.fillProjects($('project'), s.projects, s.activeProject);
  }

  api.on('prompt:show', ({ name, title, settings }) => {
    $('title').textContent = title || `Call ${BROWSERS.has(name) ? 'in' : 'on'} ${name}`;
    render(settings);
  });
  api.on('settings', render);
  $('project').addEventListener('change', () => api.updateSettings({ activeProject: $('project').value }));
  $('start').onclick = () => api.promptStart();
  $('dismiss').onclick = () => api.promptDismiss();
})();

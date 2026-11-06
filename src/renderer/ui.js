'use strict';

// Small helpers shared by the pages.
window.ui = (() => {
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function basename(p) {
    return String(p).split(/[\\/]/).filter(Boolean).pop() || '';
  }

  function tildify(p) {
    return String(p || '').replace(/^\/Users\/[^/]+/, '~');
  }

  function modelName(id) {
    if (!id) return '';
    const m = String(id).match(/(haiku|sonnet|opus|fable)[-_ ]?(\d+)?[-_.]?(\d+)?/i);
    if (!m) return id;
    const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return m[2] ? `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : name;
  }

  function toast(message, { level = 'info', action, timeout = 6000 } = {}) {
    const t = el('div', `toast ${level}`);
    t.appendChild(el('span', 'toast-text', message));
    if (action) {
      const b = el('button', 'text-btn', action.label);
      b.type = 'button';
      b.onclick = () => {
        action.run();
        t.remove();
      };
      t.appendChild(b);
    }
    const x = el('button', 'toast-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.onclick = () => t.remove();
    t.appendChild(x);
    document.getElementById('toasts').appendChild(t);
    if (timeout) setTimeout(() => t.remove(), timeout);
  }

  // Fills a project dropdown. extra: { value, label } options to add at the end.
  // A New project click left blank is not a project yet.
  function usableProjects(projects) {
    return projects.filter((p) => p.name.trim() || p.brief.trim() || p.folder || p.files.length);
  }

  // A client from a call may already be a project under a longer or shorter name.
  function hasProject(projects, name) {
    const wanted = String(name).trim().toLowerCase();
    return projects.some((p) => {
      const known = p.name.trim().toLowerCase();
      return known && (known.includes(wanted) || wanted.includes(known));
    });
  }

  // Rebuilt only when the list changes, because that closes the menu if it is open.
  function fillProjects(select, projects, active, extra = []) {
    const shown = usableProjects(projects);
    const options = [{ value: '', label: 'No project' }, ...shown.map((p) => ({ value: p.id, label: p.name || 'Untitled' })), ...extra];
    const key = JSON.stringify(options);
    if (select.dataset.options !== key) {
      select.dataset.options = key;
      select.replaceChildren(
        ...options.map(({ value, label }) => {
          const o = el('option', null, label);
          o.value = value;
          return o;
        })
      );
    }
    const value = shown.some((p) => p.id === active) ? active : '';
    if (select.value !== value) select.value = value; // setting it at all closes an open menu
  }

  return { el, basename, tildify, modelName, toast, usableProjects, hasProject, fillProjects };
})();

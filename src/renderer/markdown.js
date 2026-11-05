'use strict';

// Tiny, safe markdown for Claude's answers: paragraphs, bullet and numbered
// lists, **bold**, *italic* and `code`. All text is escaped first.
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    return t;
  }

  function render(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ul') {
          flushList();
          list = { type: 'ul', items: [] };
        }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ol') {
          flushList();
          list = { type: 'ol', items: [] };
        }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        flushPara();
        flushList();
        out.push(`<p><strong>${inline(m[1])}</strong></p>`);
        continue;
      }
      if (list && /^\s{2,}\S/.test(raw)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  if (typeof window !== 'undefined') window.renderMarkdown = render;
  if (typeof module !== 'undefined' && module.exports) module.exports = { render };
})();

'use strict';

const { EventEmitter } = require('events');

// Holds the call transcript. Lines from the two sources ("you" = microphone,
// "them" = call audio) arrive out of order, so they are kept sorted by start
// time. Without headphones the microphone also hears the other person; such
// echo lines are dropped when they match a "them" line said at the same time.
//
// Events: 'add' (line, beforeId|null), 'remove' (id)

// Whisper invents short stock lines on a quiet line, like "Thank you." 28 times in
// one real call. People rarely repeat a short line word for word, so past the
// second one it is noise. Questions always count, and so do words like "yeah".
const MAX_SHORT_WORDS = 6;
const MAX_REPEATS = 2;
const ACKNOWLEDGEMENTS = new Set(['yeah', 'yes', 'yep', 'okay', 'ok', 'right', 'no', 'sure', 'mm hmm', 'mhm', 'uh huh', 'hmm', 'oh', 'wow', 'great', 'nice', 'cool', 'exactly', 'good']);

function isStockRepeat(line, lines) {
  const said = words(line.text);
  const key = said.join(' ');
  if (!key || said.length > MAX_SHORT_WORDS || ACKNOWLEDGEMENTS.has(key) || looksLikeQuestion(line.text)) return false;
  return lines.filter((l) => l.source === line.source && words(l.text).join(' ') === key).length >= MAX_REPEATS;
}

class TranscriptStore extends EventEmitter {
  constructor() {
    super();
    this.clear();
  }

  clear() {
    this.lines = [];
    this.nextId = 1;
    this.sent = new Set();
  }

  add({ source, startMs, endMs, text }) {
    const line = { id: this.nextId++, source, startMs, endMs, text };
    if (isStockRepeat(line, this.lines)) return null;
    if (source === 'you') {
      const echo = this.lines.find((l) => l.source === 'them' && overlaps(l, line) && similar(l.text, line.text));
      if (echo) return null;
    } else if (source === 'them') {
      for (const l of this.lines.filter((x) => x.source === 'you' && overlaps(x, line) && similar(x.text, line.text))) {
        this.remove(l.id);
      }
    }
    let idx = this.lines.length;
    while (idx > 0 && this.lines[idx - 1].startMs > line.startMs) idx--;
    this.lines.splice(idx, 0, line);
    const before = this.lines[idx + 1] ? this.lines[idx + 1].id : null;
    this.emit('add', line, before);
    return line;
  }

  remove(id) {
    const i = this.lines.findIndex((l) => l.id === id);
    if (i < 0) return;
    this.lines.splice(i, 1);
    this.sent.delete(id);
    this.emit('remove', id);
  }

  // Lines not yet sent to Claude in the current session.
  takeUnsent() {
    const out = this.lines.filter((l) => !this.sent.has(l.id));
    for (const l of out) this.sent.add(l.id);
    return out;
  }

  takeAll() {
    for (const l of this.lines) this.sent.add(l.id);
    return this.lines.slice();
  }

  resetSent() {
    this.sent = new Set();
  }

  lastQuestionFromThem() {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (l.source !== 'them') continue;
      if (looksLikeQuestion(l.text)) return l;
    }
    return null;
  }
}

// Speech recognition often drops the question mark, and people ask for things
// without one ("walk me through your pricing"), so the mark alone misses them.
const LEAD_IN = '(?:(?:so|and|but|okay|ok|well|right|yeah|hey|also|now|sorry)[,\\s]+)*';
const AUX_QUESTION = new RegExp(`^${LEAD_IN}(?:can|could|would|will|do|does|did|is|are|should|have|has)\\s+(?:you|we|your|it|they|there|that|this|i)\\b`, 'i');
const WH_QUESTION = new RegExp(`^${LEAD_IN}(?:what|how|why|when|where|who|which)\\s+(?:is|are|do|does|did|would|will|can|could|should|was|were|about|much|many|long|often)\\b`, 'i');
const ASKING = /\b(?:tell me|walk me through|talk me through|help me understand|i(?:'d| would) (?:love|like) to (?:know|hear|understand)|i(?:'m| am) curious|i was wondering|curious (?:about|how|what|why))\b/i;

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (t.includes('?')) return true;
  if (t.split(/\s+/).length < 4) return false;
  return AUX_QUESTION.test(t) || WH_QUESTION.test(t) || ASKING.test(t);
}

function overlaps(a, b, slackMs = 2500) {
  return b.startMs <= a.endMs + slackMs && b.endMs >= a.startMs - slackMs;
}

function words(t) {
  return String(t)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function similar(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return false;
  if (Math.min(A.length, B.length) < 3) return A.join(' ') === B.join(' ');
  const setB = new Set(B);
  const setA = new Set(A);
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / Math.min(setA.size, setB.size) >= 0.6;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function speakerName(source) {
  return source === 'you' ? 'You' : 'Them';
}

function formatLines(lines) {
  return lines.map((l) => `[${fmtTime(l.startMs)}] ${speakerName(l.source)}: ${l.text}`).join('\n');
}

function toMarkdown({ startedAt, endedAt, lines, qa, project, note, title: callName, attendees, statsLine, notesText, notepad }) {
  const start = new Date(startedAt);
  const mins = endedAt ? Math.max(1, Math.round((endedAt - startedAt) / 60000)) : null;
  const title = start.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const out = [`# ${callName || 'Call'}, ${title}${mins ? ` (${mins} min)` : ''}`, ''];
  if (project) out.push(`Project: ${project}`, '');
  if (attendees && attendees.length) out.push(`With: ${attendees.join(', ')}`, '');
  if (note) out.push(`Note: ${note}`, '');
  if (statsLine) out.push(`Talk time: ${statsLine}`, '');
  if (notesText) out.push('## Notes', '', notesText, '');
  if (notepad && notepad.trim()) out.push('## My notes', '', notepad.trim(), '');
  out.push('## Transcript', '');
  if (!lines.length) out.push('_No speech captured._');
  for (const l of lines) out.push(`**[${fmtTime(l.startMs)}] ${speakerName(l.source)}:** ${l.text}`, '');
  const answered = qa.filter((q) => q.answer || q.error);
  if (answered.length) {
    out.push('## Questions to Claude', '');
    for (const q of answered) {
      out.push(`**Q (${fmtTime(q.atMs || 0)}):** ${q.question}`, '');
      out.push(q.answer ? q.answer.trim() : `_${q.error}_`, '');
      if (q.sources && q.sources.length) out.push(`_Notes used: ${q.sources.join(', ')}_`, '');
    }
  }
  return out.join('\n');
}

module.exports = { TranscriptStore, formatLines, toMarkdown, fmtTime, similar, speakerName, looksLikeQuestion };

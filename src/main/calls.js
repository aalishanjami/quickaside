'use strict';

const fs = require('fs');
const path = require('path');
const { looksLikeQuestion, fmtTime } = require('./transcript');

// The call library. Each call is one JSON file in the app's own data folder, so
// the library keeps working even when macOS hasn't allowed the Documents folder.
// The markdown file in the save folder is the user's own copy.

const VALID_ID = /^[\w-]+$/;

// Who talked how much. A turn is one speaker until the other one starts.
function talkStats(lines) {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const ms = { you: 0, them: 0 };
  const turns = [];
  for (const l of sorted) {
    const length = Math.max(0, l.endMs - l.startMs);
    ms[l.source] = (ms[l.source] || 0) + length;
    const last = turns[turns.length - 1];
    if (last && last.source === l.source) last.ms += length;
    else turns.push({ source: l.source, ms: length });
  }
  const total = ms.you + ms.them;
  const longest = turns.reduce((best, t) => (!best || t.ms > best.ms ? t : best), null);
  const youShare = total ? Math.round((ms.you / total) * 100) : 0;
  return {
    youMs: ms.you,
    themMs: ms.them,
    youShare,
    themShare: total ? 100 - youShare : 0,
    turns: turns.length,
    longest: longest ? { who: longest.source, ms: longest.ms } : null,
    theirQuestions: sorted.filter((l) => l.source === 'them' && looksLikeQuestion(l.text)).length,
  };
}

function callTitle(record) {
  return record.title || record.project || record.app || 'Call';
}

function metaOf(record) {
  const lines = record.lines || [];
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    title: callTitle(record),
    app: record.app || '',
    project: record.project || '',
    summary: record.notes ? record.notes.summary : '',
    lines: lines.length,
    file: record.file || '',
  };
}

function haystack(record) {
  const notes = record.notes || {};
  return [
    callTitle(record),
    record.project,
    record.notepad,
    record.note,
    notes.summary,
    notes.followUp,
    ...(record.attendees || []),
    ...(notes.decisions || []),
    ...(notes.actions || []).map((a) => a.task),
    ...(record.lines || []).map((l) => l.text),
    ...(record.qa || []).flatMap((q) => [q.question, q.answer]),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

class CallStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map(); // id -> { mtimeMs, meta, text }
  }

  _file(id) {
    if (!VALID_ID.test(String(id))) throw new Error('Not a call id.');
    return path.join(this.dir, `${id}.json`);
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  // Merges, so saving the transcript again can't wipe notes written since.
  upsert(id, patch) {
    const record = { ...this.get(id), ...patch, id };
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._file(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
    return record;
  }

  remove(id) {
    fs.rmSync(this._file(id), { force: true });
    this.cache.delete(String(id));
  }

  async _entries() {
    let names = [];
    try {
      names = (await fs.promises.readdir(this.dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        const file = path.join(this.dir, name);
        const { mtimeMs } = await fs.promises.stat(file);
        let hit = this.cache.get(id);
        if (!hit || hit.mtimeMs !== mtimeMs) {
          const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          hit = { mtimeMs, meta: metaOf(record), text: haystack(record) };
          this.cache.set(id, hit);
        }
        entries.push(hit);
      } catch {
        // an unreadable file shouldn't hide the rest of the library
      }
    }
    return entries;
  }

  // Newest first. Every word of the query has to appear somewhere in the call.
  async list(query = '') {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await this._entries();
    return entries
      .filter((e) => words.every((w) => e.text.includes(w)))
      .map((e) => e.meta)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}

// Reads a call saved as markdown before the library existed.
function parseMarkdownCall(text, fileName) {
  const when = /(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})/.exec(fileName);
  if (!when) return null;
  const [, y, mo, d, h, mi] = when.map(Number);
  const startedAt = new Date(y, mo - 1, d, h, mi).getTime();
  const seconds = (stamp) => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const lines = [];
  const qa = [];
  let question = null;
  for (const raw of String(text).split('\n')) {
    const line = /^\*\*\[([\d:]+)\] (You|Them):\*\* (.*)$/.exec(raw);
    if (line) {
      const startMs = seconds(line[1]) * 1000;
      if (lines.length) lines[lines.length - 1].endMs = Math.max(lines[lines.length - 1].startMs, startMs);
      lines.push({ id: lines.length + 1, source: line[2].toLowerCase(), startMs, endMs: startMs + 3000, text: line[3] });
      continue;
    }
    const q = /^\*\*Q \(([\d:]+)\):\*\* (.*)$/.exec(raw);
    if (q) {
      question = { question: q[2], answer: '', atMs: seconds(q[1]) * 1000, kind: 'custom', sources: [] };
      qa.push(question);
    } else if (question && raw.trim() && !raw.startsWith('#')) {
      question.answer += `${question.answer ? '\n' : ''}${raw}`;
    }
  }
  if (!lines.length && !qa.length) return null;
  const mins = /\((\d+) min\)/.exec(text);
  const project = /^Project: (.+)$/m.exec(text);
  return {
    id: `c${startedAt}`,
    startedAt,
    endedAt: mins ? startedAt + Number(mins[1]) * 60000 : startedAt,
    project: project ? project[1] : '',
    lines,
    qa,
    stats: talkStats(lines),
    imported: true,
  };
}

function statsLine(stats) {
  if (!stats || !stats.turns) return '';
  const who = stats.longest.who === 'you' ? 'You' : 'Them';
  return `You ${stats.youShare}%, Them ${stats.themShare}%. ${stats.turns} turns. Longest: ${who}, ${fmtTime(stats.longest.ms)}.`;
}

module.exports = { CallStore, talkStats, callTitle, metaOf, parseMarkdownCall, statsLine };

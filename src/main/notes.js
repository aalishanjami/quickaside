'use strict';

const { formatLines } = require('./transcript');

// The notes written after a call. One request, which returns JSON.

const NOTE_TEMPLATES = {
  general: { label: 'General', focus: 'what was discussed and what happens next' },
  sales: { label: 'Sales call', focus: "their situation, needs, budget, timeline, objections, buying signals and the next step" },
  interview: { label: 'Interview', focus: "the candidate's background, strengths, concerns and the next step in hiring" },
  oneone: { label: 'One to one', focus: 'wins, blockers, feedback and what each person committed to' },
};

const MAX_TRANSCRIPT_CHARS = 180000;

function templateOf(id) {
  return NOTE_TEMPLATES[id] ? id : 'general';
}

function buildNotes({ record, template, aboutMe, instructions, brief, knownClients = [] }) {
  const t = NOTE_TEMPLATES[templateOf(template)];
  const system = [
    "You write up the user's call. The user may send these notes to the other person, so every claim has to come from the transcript, the user's notes or <project>.",
    'Never invent names, numbers, dates, prices or commitments. If something was not said, leave it out.',
    'The transcript is automatic speech recognition and has mistakes. Infer the intended words.',
    '"You" lines are the user. "Them" lines are everyone else.',
    'Use short, plain words and no em dashes.',
    'Reply with one JSON object and nothing else.',
  ];
  if (instructions && instructions.trim()) system.push(`The user's style: ${instructions.trim()}`);
  const lines = formatLines(record.lines || []);
  const parts = [];
  if (aboutMe && aboutMe.trim()) parts.push('<about_user>', aboutMe.trim(), '</about_user>', '');
  if (brief && brief.trim()) parts.push(`<project name="${String(record.project).replace(/"/g, "'")}">`, brief.trim(), '</project>', '');
  if (record.notepad && record.notepad.trim()) parts.push('<user_notes>', record.notepad.trim(), '</user_notes>', '');
  parts.push('<transcript>', lines.length > MAX_TRANSCRIPT_CHARS ? lines.slice(-MAX_TRANSCRIPT_CHARS) : lines, '</transcript>', '');
  parts.push(`Focus on ${t.focus}.`, 'Return a JSON object with exactly these keys:');
  parts.push('- "summary": a string, two to four plain sentences.');
  parts.push('- "decisions": an array of strings, only what was actually agreed. Empty if nothing was.');
  parts.push('- "actions": an array of objects with "task" and "owner". Owner is "You", "Them" or a name that was said.');
  parts.push('- "followUp": a string, a short follow-up email from the user in the first person, with no subject line. Empty if a follow-up makes no sense.');
  // A call with no project may be the first sign of a client, so the app can offer to save one.
  if (!record.project) {
    const known = knownClients.filter(Boolean).join(', ');
    parts.push(`- "client": a string, the outside company or client this call was with, only if the name was clearly said. Not the user's own company${known ? `, and none of: ${known}` : ''}. Empty otherwise.`);
    parts.push('- "brief": a string, short plain lines for later calls with them: who they are, what they want, where it stands. Empty if "client" is empty.');
  }
  return { system: system.join('\n'), prompt: parts.join('\n') };
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function parseNotes(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  let raw;
  try {
    raw = JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error('Claude did not return notes. Try again.');
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const notes = {
    summary: str(raw.summary),
    decisions: list(raw.decisions).map(str).filter(Boolean),
    actions: list(raw.actions)
      .map((a) => ({ task: str(a && a.task), owner: str(a && a.owner) }))
      .filter((a) => a.task),
    followUp: str(raw.followUp),
  };
  if (!notes.summary) throw new Error('Claude did not return notes. Try again.');
  if (str(raw.client)) Object.assign(notes, { client: str(raw.client).slice(0, 120), brief: str(raw.brief) });
  return notes;
}

function notesToMarkdown(notes) {
  const out = [notes.summary, ''];
  if (notes.decisions.length) out.push('### Decisions', '', ...notes.decisions.map((d) => `- ${d}`), '');
  if (notes.actions.length) out.push('### Action items', '', ...notes.actions.map((a) => `- [ ] ${a.owner ? `${a.owner}: ` : ''}${a.task}`), '');
  if (notes.followUp) out.push('### Follow-up email', '', notes.followUp, '');
  return out.join('\n');
}

module.exports = { NOTE_TEMPLATES, templateOf, buildNotes, parseNotes, notesToMarkdown };

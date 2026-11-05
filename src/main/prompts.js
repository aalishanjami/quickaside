'use strict';

const fs = require('fs');
const path = require('path');
const { formatLines, fmtTime } = require('./transcript');

const MAX_FILE_CHARS = 40000;
const MAX_CONTEXT_CHARS = 120000;
const MAX_TRANSCRIPT_CHARS = 200000;

function readContextFiles(files) {
  const docs = [];
  let total = 0;
  for (const file of files || []) {
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.length > MAX_FILE_CHARS) text = `${text.slice(0, MAX_FILE_CHARS)}\n[truncated]`;
      if (total + text.length > MAX_CONTEXT_CHARS) break;
      total += text.length;
      docs.push({ name: path.basename(file), text });
    } catch {
      // missing or unreadable file: skip it
    }
  }
  return docs;
}

function buildSystemPrompt({ aboutMe, offer, audience, instructions, contextDocs, folderAccess, contextFolder, project, callNote }) {
  const notes = folderAccess && contextFolder;
  const known = [...(project ? ['<project>'] : []), '<about_user>', '<context_files>', ...(notes ? ["the user's notes"] : [])];
  const sources = `${known.join(', ')} or the transcript`;
  const parts = [
    'You are Callaside, a live assistant in a narrow side panel next to a call. The user glances at your answer while talking.',
    '',
    `Most important rule: the user may say your words out loud to a client, so every claim about the user or their company must be backed by ${sources}. That covers services, specialties, past projects, clients, results, team, prices and timelines. Do not add specifics that are not written there, even plausible ones. Use numbers and status exactly as written: keep what a number counts, and whether work is planned, in testing or live. When something is missing, have the user offer to follow up instead.`,
    '- Context says "We build AI integrations" and nothing about booking systems. Bad: "We build voice assistants that connect to booking systems." Good: "We build AI integrations, so this is our kind of work."',
    '- No timeline in the context. Bad: "A pilot takes a few weeks." Good: "I\'ll give you a timeline once we\'ve scoped it."',
    '- No past projects in the context. Bad: "We\'ve built this before." Good: "I\'ll send you our closest examples after the call."',
    '- Source says "30 invoices checked in a trial run, not ready to launch". Bad: "We processed 30 invoices for them." Good: "We trialed it on 30 invoices and are still finishing it."',
    '',
    'How to answer:',
    '- Lead with the answer. No preamble, no restating the question, no sign-off.',
    '- Keep it short: one to three sentences, or up to five short bullets. Go longer only when asked.',
    '- When asked what to say, give the exact words to say, in the first person, as natural spoken English, with no quotation marks around them.',
    '- The transcript is automatic speech recognition and has mistakes. Infer the intended words. Mention uncertainty only when it changes the answer.',
    '- "You" lines are the user (their microphone). "Them" lines are everyone else on the call (call audio), possibly several people.',
    '- For general and technical knowledge, answer directly and correctly.',
    '- Use plain text with simple markdown (bold, bullets). No headings or tables.',
  ];
  if (project) {
    parts.push(
      `- This call is about the project "${project.name}". Answer from <project> first. Facts about other clients or projects do not apply to this call: never present them as this project's, even when a search turns them up, and only mention them if asked about them by name.`
    );
  }
  if (notes) {
    const start = !project
      ? ''
      : project.folder
        ? ` Look in ${project.folder} first, and search the rest only if that does not answer it.`
        : ' Search only when <project> and <context_files> do not answer it.';
    parts.push(
      `- You can search and read the user's notes in ${contextFolder} with Glob, Grep and Read.${start} Only do it when the answer depends on them, keep it to one or two lookups, and never mention the tool calls. The notes are working logs, so read the whole sentence around a fact before you repeat it.`
    );
  }
  if (instructions && instructions.trim()) {
    parts.push('', '<user_instructions>', instructions.trim(), '</user_instructions>');
  }
  if (project) {
    parts.push('', `<project name="${project.name.replace(/"/g, "'")}">`, project.brief.trim() || '(no brief yet)', '</project>');
  }
  if (callNote && callNote.trim()) {
    parts.push('', '<call_note>', callNote.trim(), '</call_note>');
  }
  const about = [
    aboutMe && aboutMe.trim(),
    offer && offer.trim() && `What I offer:\n${offer.trim()}`,
    audience && audience.trim() && `Who I talk to:\n${audience.trim()}`,
  ].filter(Boolean);
  if (about.length) parts.push('', '<about_user>', about.join('\n\n'), '</about_user>');
  if (contextDocs && contextDocs.length) {
    parts.push('', '<context_files>');
    for (const d of contextDocs) parts.push(`<file name="${d.name.replace(/"/g, "'")}">`, d.text.trim(), '</file>');
    parts.push('</context_files>');
  }
  return parts.join('\n');
}

function clipTranscript(text) {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return `[earlier part of the call omitted]\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
}

// fresh: first message in this Claude session, so send the whole transcript.
function buildTurn({ fresh, startedAt, elapsedMs, lines, request, callActive }) {
  const when = callActive ? `Call in progress, ${fmtTime(elapsedMs)} elapsed.` : `Call ended after ${fmtTime(elapsedMs)}.`;
  const body = lines.length ? clipTranscript(formatLines(lines)) : '(nothing new)';
  if (fresh) {
    const started = startedAt ? new Date(startedAt).toLocaleString() : 'unknown';
    return [
      `<call started="${started}">${when}</call>`,
      '<transcript>',
      lines.length ? body : '(no speech captured yet)',
      '</transcript>',
      '',
      `<request>${request}</request>`,
    ].join('\n');
  }
  return [`<transcript_update>${when}`, body, '</transcript_update>', '', `<request>${request}</request>`].join('\n');
}

const QUICK_ACTIONS = {
  answer: {
    label: 'Answer their question',
    build: (q) =>
      q
        ? `They asked: "${q}". Give me the words to say, in one to three sentences.`
        : 'Find the last question the other side asked and give me the words to answer it, in one to three sentences.',
  },
  next: {
    label: 'What do I say next?',
    build: () => 'What should I say next? Give one or two options, each one or two sentences, in my voice.',
  },
  summary: {
    label: 'Summary so far',
    build: () =>
      'Summarize the call so far in up to five bullets: their situation, what they want, concerns or objections, and anything agreed.',
  },
  actions: {
    label: 'Action items',
    build: () => 'List the action items and open questions so far, with owners where stated.',
  },
};

function buildAutoRequest(questionText) {
  return `They just asked: "${questionText}". Draft my answer in one to three sentences.`;
}

module.exports = { buildSystemPrompt, buildTurn, readContextFiles, QUICK_ACTIONS, buildAutoRequest, MAX_FILE_CHARS, MAX_CONTEXT_CHARS };

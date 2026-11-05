'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TranscriptStore, formatLines, toMarkdown, similar } = require('../../src/main/transcript');
const { render } = require('../../src/renderer/markdown');
const { buildSystemPrompt, buildTurn, QUICK_ACTIONS } = require('../../src/main/prompts');
const { cleanText, isHallucination, parseInferenceBody, whisperPrompt } = require('../../src/main/transcriber');

test('transcript keeps lines sorted and reports where to insert', () => {
  const s = new TranscriptStore();
  const events = [];
  s.on('add', (l, before) => events.push([l.id, before]));
  s.add({ source: 'them', startMs: 5000, endMs: 7000, text: 'Second thing they said.' });
  s.add({ source: 'you', startMs: 1000, endMs: 3000, text: 'Hello there, thanks for joining.' });
  assert.deepStrictEqual(
    s.lines.map((l) => l.startMs),
    [1000, 5000]
  );
  assert.deepStrictEqual(events, [
    [1, null],
    [2, 1],
  ]);
});

test('echo of the other side on the mic is dropped in both arrival orders', () => {
  const s = new TranscriptStore();
  s.add({ source: 'them', startMs: 1000, endMs: 4000, text: 'We run twelve physio clinics in Sydney.' });
  const echo = s.add({ source: 'you', startMs: 1100, endMs: 4100, text: 'we run 12 physio clinics in sydney' });
  assert.strictEqual(echo, null);

  const t = new TranscriptStore();
  const removed = [];
  t.on('remove', (id) => removed.push(id));
  t.add({ source: 'you', startMs: 1100, endMs: 4100, text: 'We run twelve physio clinics in Sydney' });
  t.add({ source: 'them', startMs: 1000, endMs: 4000, text: 'We run twelve physio clinics in Sydney.' });
  assert.deepStrictEqual(removed, [1]);
  assert.strictEqual(t.lines.length, 1);

  // Same words far apart in time are kept.
  const u = new TranscriptStore();
  u.add({ source: 'them', startMs: 1000, endMs: 3000, text: 'Can you send the proposal today?' });
  assert.ok(u.add({ source: 'you', startMs: 30000, endMs: 32000, text: 'Can you send the proposal today?' }));
});

test('similarity is strict for short lines', () => {
  assert.ok(similar('Yes.', 'yes'));
  assert.ok(!similar('Yes.', 'No.'));
  assert.ok(!similar('Okay sure', 'Sure thing'));
});

test('unsent tracking and last question', () => {
  const s = new TranscriptStore();
  s.add({ source: 'them', startMs: 0, endMs: 1000, text: 'How long would it take?' });
  assert.strictEqual(s.takeUnsent().length, 1);
  s.add({ source: 'you', startMs: 2000, endMs: 3000, text: 'About six weeks.' });
  const next = s.takeUnsent();
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].text, 'About six weeks.');
  assert.strictEqual(s.lastQuestionFromThem().text, 'How long would it take?');
  s.resetSent();
  assert.strictEqual(s.takeUnsent().length, 2);
  assert.match(formatLines(s.lines), /^\[00:00\] Them: How long/);
});

test('markdown export includes transcript and answers', () => {
  const md = toMarkdown({
    startedAt: Date.now() - 125000,
    endedAt: Date.now(),
    lines: [{ id: 1, source: 'them', startMs: 2000, endMs: 3000, text: 'Hi.' }],
    qa: [{ question: 'Summary', answer: '- They said hi.', atMs: 4000 }],
  });
  assert.match(md, /^# Call, /);
  assert.match(md, /\*\*\[00:02\] Them:\*\* Hi\./);
  assert.match(md, /\*\*Q \(00:04\):\*\* Summary/);
});

test('markdown renderer escapes html and renders lists', () => {
  const html = render('**Yes.** We can <script>x</script>\n\n- one\n- two `code`\n\n1. first');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<strong>Yes\.<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two <code>code<\/code><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
});

test('prompts carry context and transcript deltas', () => {
  const sp = buildSystemPrompt({
    aboutMe: 'I run a dev agency.',
    instructions: 'No em dashes.',
    contextDocs: [{ name: 'services.md', text: 'We build AI receptionists.' }],
    folderAccess: true,
    contextFolder: '/notes',
  });
  assert.match(sp, /<about_user>\nI run a dev agency\./);
  assert.match(sp, /<file name="services.md">/);
  assert.match(sp, /\/notes with Glob, Grep and Read/);
  assert.match(sp, /Most important rule/);
  assert.match(sp, /Do not add specifics that are not written there/);
  assert.match(sp, /Use numbers and status exactly as written/);
  assert.match(sp, /<context_files>, the user's notes or the transcript/);

  const noFolder = buildSystemPrompt({ aboutMe: '', instructions: '', contextDocs: [], folderAccess: false, contextFolder: '/notes' });
  assert.match(noFolder, /<context_files> or the transcript/);
  assert.doesNotMatch(noFolder, /the user's notes/);

  const lines = [{ id: 1, source: 'them', startMs: 61000, endMs: 63000, text: 'What does it cost?' }];
  const fresh = buildTurn({ fresh: true, startedAt: Date.now(), elapsedMs: 65000, lines, request: 'Help', callActive: true });
  assert.match(fresh, /<transcript>\n\[01:01\] Them: What does it cost\?\n<\/transcript>/);
  const upd = buildTurn({ fresh: false, startedAt: Date.now(), elapsedMs: 65000, lines: [], request: 'Again', callActive: false });
  assert.match(upd, /<transcript_update>Call ended after 01:05\.\n\(nothing new\)/);
  assert.match(QUICK_ACTIONS.answer.build('How long?'), /They asked: "How long\?"/);
});

test('whisper output cleanup', () => {
  assert.strictEqual(cleanText(' [BLANK_AUDIO] '), '');
  assert.strictEqual(cleanText('Hello (laughs) there [Music]'), 'Hello there');
  assert.ok(isHallucination('Thanks for watching!'));
  assert.ok(isHallucination('you', 400));
  assert.ok(!isHallucination('you', 1500));
  assert.ok(!isHallucination('Thank you.', 600));
  assert.ok(isHallucination('Music'));
  assert.ok(!isHallucination('The music was too loud.'));
  assert.strictEqual(parseInferenceBody(200, '{"text":" hi there"}'), ' hi there');
  assert.strictEqual(parseInferenceBody(200, '{"segments":[{"text":"a"},{"text":"b"}]}'), 'a b');
  assert.throws(() => parseInferenceBody(400, '{"error":"failed to read audio data"}'), /failed to read audio/);
});

test('the vocabulary ends in a full stop, so Whisper does not carry it on in silence', () => {
  assert.strictEqual(whisperPrompt('Harbor, Dana Reed'), 'Harbor, Dana Reed.');
  assert.strictEqual(whisperPrompt('Harbor, Dana Reed,  '), 'Harbor, Dana Reed.');
  assert.strictEqual(whisperPrompt(''), '');
  assert.ok(whisperPrompt('x'.repeat(900)).length <= 601);
});

test('a short line Whisper keeps inventing stops at two, per side', () => {
  const s = new TranscriptStore();
  let at = 0;
  const say = (source, text) => s.add({ source, startMs: (at += 60000), endMs: at + 1000, text });
  assert.ok(say('you', 'Thank you.'));
  assert.ok(say('you', 'thank you'));
  assert.strictEqual(say('you', 'Thank you.'), null);
  assert.strictEqual(say('you', 'Thank you!'), null);
  assert.ok(say('them', 'Thank you.'), 'each side counts apart');
  assert.strictEqual(s.lines.filter((l) => l.source === 'you').length, 2);
});

test('real repeats stay: yes-and-no words, questions and longer lines', () => {
  const s = new TranscriptStore();
  let at = 0;
  const say = (text) => s.add({ source: 'them', startMs: (at += 60000), endMs: at + 1000, text });
  for (let i = 0; i < 4; i++) {
    assert.ok(say('Yeah.'));
    assert.ok(say('Okay.'));
    assert.ok(say('Can you hear me?'), 'a question must still reach the answers');
    assert.ok(say('We should send the proposal over by Friday morning.'));
  }
});

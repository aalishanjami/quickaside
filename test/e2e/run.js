'use strict';

// End-to-end run of the real app with a synthetic call:
//   xvfb-run -a node test/e2e/run.js [outDir]
// Needs Playwright (npm i -D playwright) and a signed-in Claude Code CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { SCRIPT, makeCallAudio, startMockWhisper } = require('./fixtures');

const root = path.join(__dirname, '..', '..');
const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'quickaside-e2e-'));

function log(...a) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userData = path.join(outDir, 'userData');
  const saveFolder = path.join(outDir, 'transcripts');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      claudeModel: process.env.E2E_MODEL || 'sonnet',
      claudeEffort: 'low',
      aboutMe:
        "I'm Sam Rivera, founder of Brightline Labs, a small software studio in Austin. We build AI integrations, data pipelines and web apps in TypeScript and Python.",
      saveFolder,
      hideFromScreenShare: false,
      autoAnswer: process.env.E2E_AUTO === '1',
      shortcut: '',
    })
  );
  const { themFile, youFile } = makeCallAudio(path.join(outDir, 'audio'));
  const whisper = await startMockWhisper();
  log('mock whisper at', whisper.url);

  // E2E_REAL_MIC=1 plays you.wav through Chromium's fake microphone, so the
  // renderer's getUserMedia -> AudioWorklet -> IPC path is exercised too.
  const realMic = process.env.E2E_REAL_MIC === '1';
  const env = {
    ...process.env,
    QUICKASIDE_USER_DATA: userData,
    QUICKASIDE_WHISPER_URL: whisper.url,
    QUICKASIDE_TEST_AUDIO_THEM: themFile,
    QUICKASIDE_TEST_SPEED: realMic ? '1' : process.env.E2E_SPEED || '2',
  };
  if (!realMic) env.QUICKASIDE_TEST_AUDIO_YOU = youFile;
  const micArgs = realMic
    ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${youFile}%noloop`]
    : [];
  const app = await electron.launch({
    executablePath: require(path.join(root, 'node_modules', 'electron')),
    args: ['--no-sandbox', `--force-device-scale-factor=${process.env.E2E_SCALE || 1}`, ...micArgs, root],
    cwd: root,
    env,
  });
  const errors = [];
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.waitForSelector('#startNow');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, '0-idle.png') });

  log('start call');
  await page.click('#startNow');
  await page.waitForFunction(() => document.body.classList.contains('live'));
  const expected = SCRIPT.length; // the echo line must not show up as an extra line
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .line').length >= n, expected, { timeout: 90000 });
  await page.waitForTimeout(2500); // let any late echo line arrive
  const lines = await page.$$eval('#transcript .line', (els) =>
    els.map((e) => ({ who: e.querySelector('.who').textContent, t: e.querySelector('.t').textContent, text: e.querySelector('.text').textContent }))
  );
  log(`transcript has ${lines.length} lines`);
  for (const l of lines) log(`  ${l.t} ${l.who}: ${l.text}`);

  const auto = process.env.E2E_AUTO === '1';
  if (auto) {
    log('waiting for the automatic answer to their question');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.qa.auto')].some((q) => !q.classList.contains('working')),
      null,
      { timeout: 120000 }
    );
  }
  log('quick action: answer their question');
  const before = auto ? 1 : 0;
  await page.click('.chip:has-text("Answer them")');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.qa').length === n + 1 && !document.querySelector('.qa').classList.contains('working'), // newest is first
    before,
    { timeout: 120000 }
  );
  log('custom question');
  await page.fill('#askInput', 'What should I ask next to qualify them?');
  await page.keyboard.press('Enter');
  // Wait until the second card is done, sampling streaming progress on the way.
  const progress = [];
  const t0 = Date.now();
  const total = before + 2;
  while (Date.now() - t0 < 120000) {
    const st = await page.$$eval('.qa', (els) => els.map((e) => ({ working: e.classList.contains('working'), len: e.querySelector('.a').textContent.length })));
    if (st.length === total) progress.push(st[0].len);
    if (st.length === total && !st[0].working) break;
    await page.waitForTimeout(150);
  }
  const qa = await page.$$eval('.qa', (els) =>
    els.map((e) => ({ q: e.querySelector('.qtext').textContent, a: e.querySelector('.a').innerText, note: e.querySelector('.note').textContent, error: e.classList.contains('error') }))
  );
  for (const x of qa) log(`Q: ${x.q}\nA (${x.note}${x.error ? ', ERROR' : ''}): ${x.a}`);
  const distinct = [...new Set(progress)].length;
  log(`streaming samples for answer 2: ${distinct} distinct lengths`);
  await page.screenshot({ path: path.join(outDir, '1-live.png') });

  log('stop call');
  await page.click('#endBtn');
  await page.waitForFunction(() => document.body.classList.contains('ended') && !document.querySelector('#endBtn').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const files = fs.existsSync(saveFolder) ? fs.readdirSync(saveFolder) : [];
  log('saved transcripts:', files);
  const saved = files.length ? fs.readFileSync(path.join(saveFolder, files[0]), 'utf8') : '';
  await page.screenshot({ path: path.join(outDir, '2-ended.png') });

  const [settingsPage] = await Promise.all([app.waitForEvent('window'), page.click('#settingsBtn')]);
  await settingsPage.waitForSelector('.nav-item[aria-current="page"]');
  await settingsPage.click('[data-section="knowledge"]');
  await settingsPage.waitForTimeout(400);
  await settingsPage.screenshot({ path: path.join(outDir, '3-settings.png') });

  const result = {
    lines,
    qa,
    whisperRequests: whisper.requests,
    savedFile: files[0] || null,
    savedHasQa: /## Questions to Claude/.test(saved),
    errors,
    streamingDistinct: distinct,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

  const problems = [];
  if (lines.length !== expected) problems.push(`expected ${expected} lines, got ${lines.length}`);
  if (lines.filter((l) => l.text === SCRIPT[0].text).length !== 1) problems.push('echo line was not removed');
  if (lines.some((l, i) => i > 0 && l.t < lines[i - 1].t)) problems.push('lines out of order');
  if (qa.length !== total || qa.some((x) => x.error || !x.a.trim())) problems.push('answers missing or failed');
  if (!result.savedFile || !result.savedHasQa) problems.push('transcript file missing or incomplete');
  if (errors.length) problems.push(`renderer errors: ${errors.join(' | ')}`);
  await app.close();
  whisper.close();
  log(problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS');
  log('output in', outDir);
  process.exit(problems.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

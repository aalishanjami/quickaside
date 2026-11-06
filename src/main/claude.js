'use strict';

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Talks to the Claude Code CLI installed on this Mac, signed in with the
// user's own Claude account. No API key is involved: we run the official
// `claude` binary in print mode with streaming JSON in and out, and keep one
// process alive per call so follow-up questions skip startup time.
//
// Events:
//   'status' { state, version, model, error }
//   'answer' { id, status?, text?, done?, error?, cancelled?, durationMs? }

class ClaudeSession extends EventEmitter {
  constructor({ resolveClaude, getEnv, getConfig, buildMessage, scratchDir, log }) {
    super();
    this.log = log;
    this.resolveClaude = resolveClaude;
    this.getEnv = getEnv;
    this.getConfig = getConfig; // () => { model, effort, systemPrompt, folderAccess, folder }
    this.buildMessage = buildMessage; // (item, { fresh }) => string
    this.scratchDir = scratchDir || path.join(os.tmpdir(), 'quickaside');
    this.proc = null;
    this.queue = [];
    this.current = null;
    this.sentInProc = 0;
    this.caps = null;
    this.capsFor = null;
    this.status = { state: 'idle', version: null, model: null, error: null };
    this.inlinePromptOnly = false;
    this.restartWhenIdle = false;
    this.onceCount = 0;
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  async check() {
    const bin = await this.resolveClaude();
    if (!bin) {
      this._setStatus({ state: 'missing', error: 'Claude Code not found.' });
      return this.status;
    }
    await this._capabilities(bin);
    if (this.status.state === 'missing' || this.status.state === 'idle') this._setStatus({ state: 'idle', error: null });
    return this.status;
  }

  async _capabilities(bin) {
    if (this.caps && this.capsFor === bin) return this.caps;
    const env = await this.getEnv();
    const run = (args) =>
      new Promise((resolve) => {
        execFile(bin, args, { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (_e, so, se) => resolve(`${so || ''}\n${se || ''}`));
      });
    const [help, version] = await Promise.all([run(['--help']), run(['--version'])]);
    const flags = new Set(help.match(/--[a-z][a-z-]+/g) || []);
    this.caps = { flags, dontAsk: /dontAsk/.test(help) };
    this.capsFor = bin;
    const v = version.match(/\d+\.\d+\.\d+/);
    this._setStatus({ version: v ? v[0] : null });
    return this.caps;
  }

  // Starts the process early so the first question doesn't wait for startup.
  async warm() {
    try {
      await this._ensureProcess();
    } catch (err) {
      // surfaced through status; the next ask() reports it on the card too
    }
  }

  // The flags every Claude run shares: locked down, and read-only tools only
  // when the notes folder is in use.
  _commonArgs(caps, cfg, folder) {
    const has = (f) => caps.flags.has(f);
    const args = [];
    if (has('--safe-mode')) args.push('--safe-mode');
    if (has('--no-session-persistence')) args.push('--no-session-persistence');
    if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.effort && has('--effort')) args.push('--effort', cfg.effort);
    if (has('--tools')) args.push('--tools', folder ? 'Read,Glob,Grep' : '');
    else args.push('--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task');
    if (folder) args.push('--add-dir', folder);
    if (has('--permission-mode') && caps.dontAsk) args.push('--permission-mode', 'dontAsk');
    if (has('--permission-prompts')) args.push('--permission-prompts', 'none');
    return args;
  }

  // One request outside the call, for the spark buttons in Settings. Runs in
  // its own process, so it can't disturb a call. Returns { done, cancel }.
  once({ system, prompt, folder, timeoutMs = 180000, onFile }) {
    let proc = null;
    let cancelled = false;
    const done = (async () => {
      const bin = await this.resolveClaude();
      if (!bin) throw new Error('Claude Code is not installed. Install it, sign in, then try again.');
      const caps = await this._capabilities(bin);
      const cfg = this.getConfig();
      fs.mkdirSync(this.scratchDir, { recursive: true });
      // One file each: a draft and after-call notes can run at the same time.
      const promptFile = path.join(this.scratchDir, `once-${process.pid}-${++this.onceCount}.md`);
      fs.writeFileSync(promptFile, system);
      const args = ['-p', '--output-format', 'stream-json', '--verbose', ...this._commonArgs(caps, cfg, folder), '--system-prompt-file', promptFile];
      const env = await this.getEnv();
      if (cancelled) throw new Error('Cancelled.');
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        proc = spawn(bin, args, { cwd: folder || this.scratchDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error('That took too long. Try again.'));
        }, timeoutMs);
        const files = new Set();
        let result = null;
        let settled = false;
        let buffer = '';
        let stderr = '';
        // The result message is the end of the work. Waiting for the process to
        // close instead can take minutes, if anything keeps its output open.
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fs.rm(promptFile, { force: true }, () => {});
          if (this.log) this.log.info('once.result', { ms: Date.now() - startedAt, apiMs: result && result.duration_api_ms });
          if (cancelled) return reject(new Error('Cancelled.'));
          if (!result) return reject(new Error(friendlyError(stderr) || 'Claude Code stopped before it finished.'));
          if (result.is_error || (result.subtype && result.subtype !== 'success')) {
            return reject(new Error(friendlyError(result.result || result.subtype) || 'Claude Code could not finish.'));
          }
          resolve({ text: String(result.result || ''), files: [...files] });
        };
        const onLine = (line) => {
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            return;
          }
          if (m.type === 'assistant' || m.type === 'user') {
            for (const f of m.type === 'assistant' ? readPaths(m.message) : grepPaths(m.tool_use_result)) {
              if (files.has(f)) continue;
              files.add(f);
              if (onFile) onFile(f);
            }
          } else if (m.type === 'result') {
            result = m;
            settle();
            setTimeout(() => proc.kill(), 2000); // it has nothing left to do
          }
        };
        proc.stdout.on('data', (d) => {
          buffer += d.toString('utf8');
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            onLine(buffer.slice(0, i).trim());
            buffer = buffer.slice(i + 1);
          }
        });
        proc.stderr.on('data', (d) => {
          stderr = (stderr + d.toString('utf8')).slice(-3000);
        });
        proc.stdin.on('error', () => {});
        proc.stdin.end(prompt);
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on('close', () => {
          if (this.log) this.log.info('once.closed', { ms: Date.now() - startedAt });
          settle();
        });
      });
    })();
    return {
      done,
      cancel: () => {
        cancelled = true;
        if (proc) proc.kill('SIGKILL');
      },
    };
  }

  async _ensureProcess() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const bin = await this.resolveClaude();
    if (!bin) {
      this._setStatus({ state: 'missing', error: 'Claude Code not found.' });
      throw new Error('Claude Code is not installed or not on your PATH. Install it, run `claude` once in Terminal to sign in, then try again.');
    }
    const caps = await this._capabilities(bin);
    const cfg = this.getConfig();
    fs.mkdirSync(this.scratchDir, { recursive: true });

    const folderOk = cfg.folderAccess && cfg.folder && fs.existsSync(cfg.folder);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (caps.flags.has('--include-partial-messages')) args.push('--include-partial-messages');
    args.push(...this._commonArgs(caps, cfg, folderOk ? cfg.folder : null));
    if (this.inlinePromptOnly) {
      args.push('--system-prompt', cfg.systemPrompt);
    } else {
      const promptFile = path.join(this.scratchDir, 'system-prompt.md');
      fs.writeFileSync(promptFile, cfg.systemPrompt);
      args.push('--system-prompt-file', promptFile);
    }

    const env = await this.getEnv();
    const proc = spawn(bin, args, {
      cwd: folderOk ? cfg.folder : this.scratchDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.sentInProc = 0;
    this.stdoutBuf = '';
    this.stderrTail = '';
    this.spawnedAt = Date.now();
    this._setStatus({ state: 'ready', error: null, model: cfg.model });

    proc.stdout.on('data', (d) => this._onStdout(proc, d));
    proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-3000);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this._onExit(proc, null, null, err));
    proc.on('exit', (code, signal) => this._onExit(proc, code, signal));
  }

  _onExit(proc, code, signal, err) {
    if (this.proc !== proc) return;
    this.proc = null;
    const tail = this.stderrTail.trim();
    if (!this.inlinePromptOnly && /unknown option.*system-prompt-file/i.test(tail)) {
      // Older Claude Code: fall back to passing the prompt inline, then retry.
      this.inlinePromptOnly = true;
      if (this.current) {
        this.queue.unshift(this.current);
        this.current = null;
      }
      this._pump();
      return;
    }
    const cur = this.current;
    this.current = null;
    if (cur && !cur.cancelled) {
      const reason = err ? err.message : friendlyError(tail) || `Claude Code stopped (exit ${code ?? signal}).`;
      this.emit('answer', { id: cur.id, done: true, error: reason });
    }
    if (code && code !== 0 && code !== 143 && !cur) {
      const msg = friendlyError(tail);
      if (msg) this._setStatus({ state: 'error', error: msg });
    } else if (this.status.state !== 'missing') {
      this._setStatus({ state: 'idle' });
    }
    this._pump();
  }

  _onStdout(proc, data) {
    if (this.proc !== proc) return;
    this.stdoutBuf += data.toString('utf8');
    let i;
    while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, i).trim();
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(m) {
    const cur = this.current;
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init' && m.model) this._setStatus({ model: m.model });
        else if (m.subtype === 'api_retry' && cur) {
          this.emit('answer', { id: cur.id, status: `Retrying (${m.attempt}/${m.max_retries})` });
        }
        break;
      }
      case 'stream_event': {
        if (!cur || m.parent_tool_use_id) break;
        const e = m.event || {};
        if (e.type === 'message_start' && e.message?.id) {
          cur.streamed.add(e.message.id);
        } else if (e.type === 'content_block_start') {
          const kind = e.content_block?.type;
          if (kind === 'tool_use') this.emit('answer', { id: cur.id, status: 'Checking your notes' });
          else if (kind === 'text' && cur.text && !/\n\s*$/.test(cur.text)) cur.text += '\n\n';
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          cur.text += e.delta.text;
          this._emitText(cur);
        }
        break;
      }
      case 'assistant': {
        if (!cur || m.parent_tool_use_id) break;
        const msg = m.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (blocks.some((b) => b.type === 'tool_use')) {
          const files = readPaths(msg);
          for (const f of files) cur.sources.add(f);
          const reading = files.length ? `Reading ${path.basename(files[files.length - 1])}` : 'Checking your notes';
          this.emit('answer', { id: cur.id, status: reading, sources: [...cur.sources] });
        }
        if (msg.id && cur.streamed.has(msg.id)) break;
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) {
          cur.text += (cur.text ? '\n\n' : '') + text;
          this._emitText(cur);
        }
        break;
      }
      case 'user': {
        // A search can answer on its own, with no file opened afterwards.
        if (!cur || m.parent_tool_use_id) break;
        const files = grepPaths(m.tool_use_result);
        if (files.length) {
          for (const f of files) cur.sources.add(f);
          this.emit('answer', { id: cur.id, sources: [...cur.sources] });
        }
        break;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info || {};
        if (info.status === 'rejected' && cur) {
          this.emit('answer', { id: cur.id, status: 'Usage limit reached on your Claude plan' });
        }
        break;
      }
      case 'result': {
        if (!cur) break;
        this.current = null;
        clearTimeout(cur.flushTimer);
        if (m.is_error || (m.subtype && m.subtype !== 'success')) {
          const raw = typeof m.result === 'string' && m.result ? m.result : m.subtype;
          this.emit('answer', { id: cur.id, done: true, error: friendlyError(raw) || raw });
        } else {
          const finalText = typeof m.result === 'string' && m.result.trim() ? m.result : cur.text;
          this.emit('answer', { id: cur.id, done: true, text: finalText.trim(), durationMs: Date.now() - cur.sentAt });
        }
        this._setStatus({ state: 'ready' });
        if (this.restartWhenIdle) {
          this.restartWhenIdle = false;
          this._kill();
        }
        this._pump();
        break;
      }
      default:
        break;
    }
  }

  _emitText(cur) {
    // Throttle UI updates to ~25 per second.
    if (cur.flushTimer) return;
    cur.flushTimer = setTimeout(() => {
      cur.flushTimer = null;
      if (this.current === cur) this.emit('answer', { id: cur.id, text: cur.text });
    }, 40);
  }

  ask(item) {
    this.queue.push({ ...item, text: '', streamed: new Set(), sources: new Set(), cancelled: false });
    if (this.current || this.queue.length > 1) this.emit('answer', { id: item.id, status: 'Queued' });
    this._pump();
  }

  async _pump() {
    if (this.current || !this.queue.length || this.pumping) return;
    this.pumping = true;
    try {
      await this._ensureProcess();
    } catch (err) {
      this.pumping = false;
      const items = this.queue.splice(0);
      for (const it of items) this.emit('answer', { id: it.id, done: true, error: err.message });
      return;
    }
    this.pumping = false;
    if (this.current || !this.queue.length || !this.proc) return;
    const item = this.queue.shift();
    this.current = item;
    item.sentAt = Date.now();
    const fresh = this.sentInProc === 0;
    let content;
    try {
      content = this.buildMessage(item, { fresh });
    } catch (err) {
      this.current = null;
      this.emit('answer', { id: item.id, done: true, error: `Could not build the request: ${err.message}` });
      return this._pump();
    }
    this.sentInProc++;
    this._setStatus({ state: 'busy' });
    this.emit('answer', { id: item.id, status: 'Thinking' });
    this.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  }

  cancel(id) {
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.emit('answer', { id, done: true, cancelled: true });
      return;
    }
    if (this.current && this.current.id === id) {
      const cur = this.current;
      cur.cancelled = true;
      this.current = null;
      clearTimeout(cur.flushTimer);
      this.emit('answer', { id, done: true, cancelled: true, text: cur.text });
      this._kill(); // next question starts a fresh process with the full transcript
      this._pump();
    }
  }

  // Settings changed: apply on the next question.
  configChanged() {
    if (this.current) this.restartWhenIdle = true;
    else this._kill();
  }

  // New call: forget the previous conversation.
  reset() {
    for (const it of this.queue.splice(0)) this.emit('answer', { id: it.id, done: true, cancelled: true });
    if (this.current) this.cancel(this.current.id);
    this._kill();
  }

  _kill() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {}
    const t = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {}
    }, 2000);
    p.once('exit', () => clearTimeout(t));
    try {
      p.kill('SIGTERM');
    } catch {}
    if (this.status.state !== 'missing') this._setStatus({ state: 'idle' });
  }

  dispose() {
    this.queue = [];
    this.current = null;
    this._kill();
  }
}

// The files a message opened with the Read tool.
function readPaths(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path).map((b) => b.input.file_path);
}

// The files a content search matched. Lines look like "a/b.md:2:text", and
// context lines around a match use "-" instead, so they don't count.
function grepPaths(result) {
  if (!result || result.mode !== 'content' || typeof result.content !== 'string') return [];
  const files = new Set();
  for (const line of result.content.split('\n')) {
    const m = line.match(/^(.+?):\d+:/);
    if (m) files.add(m[1]);
    if (files.size >= 3) break;
  }
  return [...files];
}

function friendlyError(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  if (/not logged in|please run \/login|\/login|invalid api key|authenticat|oauth|credential/i.test(t)) {
    return 'Claude Code is not signed in. Open Terminal, run `claude`, sign in with your Claude account, then ask again.';
  }
  if (/rate limit|usage limit|limit reached|429/i.test(t)) {
    return 'Your Claude plan hit its usage limit. It resets later; answers will work again then.';
  }
  if (/model.*(not found|not available|invalid)/i.test(t)) {
    return 'That Claude model is not available on your plan. Pick another one in Settings.';
  }
  const lines = t.trim().split('\n').filter(Boolean);
  return lines.slice(-2).join(' ').slice(0, 400);
}

module.exports = { ClaudeSession, friendlyError, readPaths, grepPaths };

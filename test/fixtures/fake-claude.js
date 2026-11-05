#!/usr/bin/env node
'use strict';

// Stands in for the `claude` CLI in unit tests. Speaks the same stream-json
// protocol: one JSON message per line on stdin, events on stdout.

const fs = require('fs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: claude [options]\n --print --input-format --output-format --verbose --include-partial-messages --safe-mode ' +
      '--no-session-persistence --strict-mcp-config --model --effort --system-prompt --tools --add-dir ' +
      '--permission-mode (choices: "acceptEdits", "dontAsk") --permission-prompts'
  );
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_CLAUDE_NO_FILE_FLAG && args.includes('--system-prompt-file')) {
  console.error("error: unknown option '--system-prompt-file'");
  process.exit(1);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let n = 0;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 20));

function handle(msg) {
  n++;
  const content = msg.message.content;
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(content)}\n`);
  if (n === 1) out({ type: 'system', subtype: 'init', model: 'claude-fake-1-0', tools: [] });
  if (process.env.FAKE_CLAUDE_MODE === 'error') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    return;
  }
  const fresh = content.includes('<transcript>');
  const reply = `Turn ${n}. fresh=${fresh}.`;
  const id = `msg_${n}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const parts = reply.match(/.{1,5}/g);
  let k = 0;
  const delay = Number(process.env.FAKE_CLAUDE_DELAY || 5);
  const tick = () => {
    if (k < parts.length) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parts[k++] } } });
      setTimeout(tick, delay);
    } else {
      out({ type: 'assistant', message: { id, content: [{ type: 'text', text: reply }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 10 });
    }
  };
  tick();
}

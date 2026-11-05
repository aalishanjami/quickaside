#!/usr/bin/env node
'use strict';

// Stands in for Homebrew's whisper-cli in unit tests: reads -f <wav>,
// writes the transcript to <-of value>.txt like `whisper-cli -otxt` does.

const fs = require('fs');

const args = process.argv.slice(2);
if (process.env.FAKE_WCLI_ARGS) fs.appendFileSync(process.env.FAKE_WCLI_ARGS, `${JSON.stringify(args)}\n`);
const input = args[args.indexOf('-f') + 1];
const outBase = args[args.indexOf('-of') + 1];
if (!input || !fs.existsSync(input)) {
  console.error('error: input file not found');
  process.exit(1);
}
const wav = fs.readFileSync(input);
const ok = wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 16000;
fs.writeFileSync(`${outBase}.txt`, ok ? ' Hello from whisper-cli.\n' : ' unexpected audio format\n');

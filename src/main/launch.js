'use strict';

// A public build holds mic and call audio permissions that other programs don't,
// so it takes no options from outside. A debugger switch or a test variable would
// let any program on the Mac run its own code under those permissions.

const CONNECTOR_FLAG = '--connector';
const ALLOWED = new Set([CONNECTOR_FLAG, '--data']);
const MACOS_ARG = /^-(psn_|NS|Apple)/; // macOS's own. Chromium reads one dash as a switch too, so nothing else passes.

function refuseLaunch(args) {
  return args.some((arg) => arg.startsWith('-') && !ALLOWED.has(arg) && !MACOS_ARG.test(arg));
}

function dropTestEnv(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('CALLASIDE_')) delete env[key];
  }
}

module.exports = { CONNECTOR_FLAG, refuseLaunch, dropTestEnv };

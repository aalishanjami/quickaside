'use strict';

// The first code the app runs, so it decides before anything reads a switch or
// a test variable. release-mac.sh sets `release` in the bundle's package.json.

const path = require('path');
const { app } = require('electron');
const { release } = require('../../package.json');
const { CONNECTOR_FLAG, refuseLaunch, dropTestEnv } = require('./launch');

const args = process.argv.slice(1);
if (release) dropTestEnv(process.env);

if (release && refuseLaunch(args)) {
  app.exit(1);
} else if (args.includes(CONNECTOR_FLAG)) {
  // Claude Code starts the server this way, beside the app or without it. It gets
  // its own folder, so it can't touch the running app's browser data.
  app.setPath('userData', path.join(app.getPath('temp'), 'quickaside-connector'));
  app.disableHardwareAcceleration();
  const { serve, dataDirFrom } = require('../connector/server');
  serve(dataDirFrom(process.argv));
} else {
  require('./main');
}

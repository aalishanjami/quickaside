'use strict';
// Draws the app icon and the menu bar images from the SVGs in build/.
// Run `npm run icon` after changing one. The results are committed, so a normal
// build doesn't need this. It uses Electron to draw and iconutil to pack, so macOS only.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ASSETS = path.join(ROOT, 'src', 'assets');

// A @2x file holds twice the pixels, so icon_16x16@2x.png is 32 px.
const ICONSET = [
  ['icon_16x16.png', 'icon-small.svg', 16],
  ['icon_16x16@2x.png', 'icon-small.svg', 32],
  ['icon_32x32.png', 'icon-small.svg', 32],
  ['icon_32x32@2x.png', 'icon.svg', 64],
  ['icon_128x128.png', 'icon.svg', 128],
  ['icon_128x128@2x.png', 'icon.svg', 256],
  ['icon_256x256.png', 'icon.svg', 256],
  ['icon_256x256@2x.png', 'icon.svg', 512],
  ['icon_512x512.png', 'icon.svg', 512],
  ['icon_512x512@2x.png', 'icon.svg', 1024],
];

const OTHERS = [
  [path.join(ASSETS, 'trayTemplate.png'), 'tray.svg', 16],
  [path.join(ASSETS, 'trayTemplate@2x.png'), 'tray.svg', 32],
  [path.join(ASSETS, 'icon.png'), 'icon.svg', 512], // goes in the Claude Desktop bundle
];

async function draw(win, svg, size, out) {
  const url = `data:image/svg+xml;base64,${fs.readFileSync(path.join(BUILD, svg)).toString('base64')}`;
  const png = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Could not draw ${svg}'));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png'));
    };
    image.src = ${JSON.stringify(url)};
  })`);
  fs.writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
}

async function main() {
  if (app.dock) app.dock.hide();
  await app.whenReady();
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quickaside-icon-'));
  const iconset = path.join(temp, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const [name, svg, size] of ICONSET) await draw(win, svg, size, path.join(iconset, name));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
  fs.rmSync(temp, { recursive: true, force: true });

  for (const [out, svg, size] of OTHERS) await draw(win, svg, size, out);
  console.log('Drew build/icon.icns and the images in src/assets.');
}

main().then(
  () => app.exit(0),
  (err) => {
    console.error(err);
    app.exit(1);
  }
);

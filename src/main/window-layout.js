'use strict';

const MIN_WIDTH = 640;
const MAX_WIDTH = 880;
const MIN_HEIGHT = 480;
const MAX_HEIGHT = 680;
const GAP = 16;

// Where the settings window goes, given the panel and the screen it is on.
// The panel floats above everything, so settings sits beside it when it can.
// `clear` is false when there is no room, and the caller must then float it too.
function settingsBounds(panel, workArea) {
  const left = panel.x - workArea.x;
  const right = workArea.x + workArea.width - (panel.x + panel.width);
  const side = Math.max(left, right);
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, side - 2 * GAP));
  const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, workArea.height - 80));
  const clear = side >= width + GAP;
  let x;
  if (!clear) x = workArea.x + Math.round((workArea.width - width) / 2);
  else if (left >= right) x = workArea.x + Math.round((left - width) / 2);
  else x = panel.x + panel.width + Math.round((right - width) / 2);
  const y = workArea.y + Math.round((workArea.height - height) / 2);
  return { x, y, width, height, clear };
}

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 720;
const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 440;
const PANEL_BAR_HEIGHT = 44; // minimized: the title bar and nothing else
const PROMPT_WIDTH = 340;
const PROMPT_HEIGHT = 72;
const MARGIN = 12;

function centeredBounds(workArea) {
  const width = Math.max(MIN_WIDTH, Math.min(880, workArea.width - 32));
  const height = Math.max(MIN_HEIGHT, Math.min(680, workArea.height - 32));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    clear: true,
  };
}

function contains(area, x, y) {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

// Top right, close to the webcam. A saved position wins while it is still on a
// screen, which it may not be after unplugging a monitor.
function panelBounds(workArea, saved, allAreas = [workArea]) {
  if (saved && saved.width >= PANEL_MIN_WIDTH && saved.height >= PANEL_MIN_HEIGHT) {
    const midX = saved.x + saved.width / 2;
    if (allAreas.some((a) => contains(a, midX, saved.y + 8))) return saved;
  }
  const height = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_HEIGHT, workArea.height - MARGIN * 2));
  return {
    x: workArea.x + workArea.width - PANEL_WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    width: PANEL_WIDTH,
    height,
  };
}

function promptBounds(workArea) {
  return {
    x: workArea.x + workArea.width - PROMPT_WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    width: PROMPT_WIDTH,
    height: PROMPT_HEIGHT,
  };
}

module.exports = {
  settingsBounds,
  centeredBounds,
  panelBounds,
  promptBounds,
  MIN_WIDTH,
  MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_MIN_HEIGHT,
  PANEL_BAR_HEIGHT,
};

'use strict';

// There is one window. It is the narrow panel on a call, and grows into a normal
// app window with a sidebar between calls.

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 720;
const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 440;
const HEAD_HEIGHT = 44; // the title bar, which is also the whole panel when shrunk to a bar
const RAIL_WIDTH = 176;
const WIDE_WIDTH = 1040;
const WIDE_HEIGHT = 700;
const WIDE_MIN_WIDTH = 760;
const WIDE_MIN_HEIGHT = 520;
const SETUP_WIDTH = 560;
const SETUP_HEIGHT = 680;
const PROMPT_WIDTH = 340;
const PROMPT_HEIGHT = 72;
const MARGIN = 12;

function contains(area, x, y) {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
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

function nearRightEdge(rect, workArea) {
  return rect.x + rect.width / 2 > workArea.x + workArea.width / 2;
}

// The window grows out from the side of the screen the panel is on, so it stays
// on screen and the panel can come back to the same place.
function wideBounds(panel, workArea, size) {
  const width = Math.min(workArea.width, Math.max(WIDE_MIN_WIDTH, (size && size.width) || WIDE_WIDTH));
  const height = Math.min(workArea.height, Math.max(WIDE_MIN_HEIGHT, (size && size.height) || Math.max(WIDE_HEIGHT, panel.height)));
  const x = nearRightEdge(panel, workArea) ? panel.x + panel.width - width : panel.x;
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(panel.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

// Back to the panel from wherever the wide window was moved to.
function panelFromWide(wide, panel, workArea) {
  const x = nearRightEdge(wide, workArea) ? wide.x + wide.width - panel.width : wide.x;
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - panel.width),
    y: clamp(wide.y, workArea.y, workArea.y + workArea.height - panel.height),
    width: panel.width,
    height: panel.height,
  };
}

function setupBounds(workArea) {
  const width = Math.min(SETUP_WIDTH, workArea.width);
  const height = Math.min(SETUP_HEIGHT, workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
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
  panelBounds,
  wideBounds,
  panelFromWide,
  setupBounds,
  promptBounds,
  PANEL_MIN_WIDTH,
  PANEL_MIN_HEIGHT,
  HEAD_HEIGHT,
  RAIL_WIDTH,
  WIDE_MIN_WIDTH,
  WIDE_MIN_HEIGHT,
};

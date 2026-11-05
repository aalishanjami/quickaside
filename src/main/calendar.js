'use strict';

const { execFile } = require('child_process');

// Works out who a call is with, through the small Swift helper in
// scripts/calendar-helper.swift. Off until the user turns it on.

const EARLY_MS = 15 * 60 * 1000; // people join a little before the start time

function run(bin, arg, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, [arg], { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// The event this call most likely is: not all-day, happening now or about to
// start, and one with other people on it beats one without.
function pickEvent(events, now = Date.now()) {
  const live = events.filter((e) => !e.allDay && e.start - EARLY_MS <= now && now <= e.end);
  const score = (e) => (e.attendees.length ? 2 : 0) + (e.start <= now ? 1 : 0);
  return live.sort((a, b) => score(b) - score(a) || Math.abs(a.start - now) - Math.abs(b.start - now))[0] || null;
}

function squash(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The project this event is about, or null. A guess shows on the prompt, where
// the user can change it, so it only fires on one clear match.
function matchProject(event, projects) {
  if (!event) return null;
  const title = squash(event.title);
  const domains = event.attendees.map((a) => squash(String(a.email || '').split('@')[1] || '').replace(/(com|net|org|io|co|ai|app)$/, ''));
  const hits = projects.filter((p) => {
    const name = squash(p.name);
    if (name.length < 3) return false;
    if (title.includes(name)) return true;
    if (domains.some((d) => d.length >= 3 && (d === name || name.includes(d) || d.includes(name)))) return true;
    return event.attendees.some((a) => a.name && a.name.includes(' ') && p.brief.toLowerCase().includes(a.name.toLowerCase()));
  });
  return hits.length === 1 ? hits[0].id : null;
}

class Calendar {
  constructor({ resolveBinary, log }) {
    this.resolveBinary = resolveBinary;
    this.log = log;
  }

  async status() {
    const bin = this.resolveBinary();
    if (!bin) return 'missing';
    return (await run(bin, 'status', 3000)) || 'missing';
  }

  // Raises the macOS prompt, so it waits for the user.
  async request() {
    const bin = this.resolveBinary();
    if (!bin) return 'missing';
    return (await run(bin, 'request', 120000)) || 'denied';
  }

  async events() {
    const bin = this.resolveBinary();
    if (!bin) return [];
    const out = await run(bin, 'now', 2500);
    try {
      return JSON.parse(out).map((e) => ({
        title: String(e.title || ''),
        start: Number(e.start) * 1000,
        end: Number(e.end) * 1000,
        allDay: !!e.allDay,
        attendees: (Array.isArray(e.attendees) ? e.attendees : []).filter((a) => !a.me).map((a) => ({ name: String(a.name || ''), email: String(a.email || '') })),
      }));
    } catch {
      this.log.warn('calendar.read', { error: 'no usable output' });
      return [];
    }
  }
}

module.exports = { Calendar, pickEvent, matchProject };

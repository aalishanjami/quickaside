# Changelog

Each release's changes, newest first. The git tag and the version in `package.json` must match, or the update service keeps offering that release.

## 0.1.1 (2026-11-06)

### The app

- One window instead of three, with the usual red, yellow and green buttons and a sidebar. On a call it's the narrow panel.
- A Dock icon and an app menu, as well as the menu bar icon.
- The window comes back after a macOS permission prompt, instead of staying behind other apps.
- Settings went from nine sections to three, and from about 27 choices to 10. The rest have good defaults, and still work from `settings.json`.
- Setup went from five steps to three. The speech model downloads while you do the others.
- The reminder to tell people on a call can't be turned off.

### Projects

- Projects are optional, and a notes folder is no longer needed to find them.
- Find my projects reads what Claude Code remembers on this Mac, your notes and your past calls.
- After a call with a new client, the app offers to save a project.
- Paste in your Claude chat memory, which the app can't reach by itself.

## 0.1.0 (2026-11-06)

The first public version.

### Calls

- Live transcript of your mic and the call audio, made on your Mac with Whisper. Audio is never saved.
- Works with any call app, because it hears what your Mac plays.
- Spots a call when an app opens the mic, and offers to start. It never starts by itself.
- Pause, and a one-click heads-up line for the meeting chat.

### Answers

- Ask Claude about the call, through your own Claude Code login. No API key.
- Every question from the other side can get an answer without you asking.
- Answers show the notes they came from.
- Projects keep each client's brief and files apart. Suggest projects finds them in your notes.

### After the call

- Summary, decisions, action items and a follow-up email, with templates.
- Past calls, with search, editing and asking across calls.
- Notepad, talk time, and call names from your calendar if you turn that on.
- A read-only connector, so your own Claude Code or Claude Desktop can search saved calls.

### The app

- A first-run window that sets everything up and tests the permissions.
- Lives in the menu bar. The panel minimizes to a small bar.
- Updates itself, and never during a call.
- Report a problem shows what it would share, and you send it yourself.

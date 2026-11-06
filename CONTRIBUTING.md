# Contributing

Thanks for helping. For anything bigger than a small fix, please open an issue first so we can agree on it before you build it.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

You need a Mac on macOS 14.2 or later, Node.js 22, the Xcode Command Line Tools and a signed-in [Claude Code](https://claude.com/claude-code).

```bash
bash setup.sh
```

That installs the dependencies, builds `whisper-server`, downloads the speech model and builds the app.

```bash
npm start
```

Run it from Terminal.app. In this mode Terminal holds the mic and call audio permissions, not the app.

```bash
npm test
```

The tests need no Mac, and they use fakes for `claude` and `whisper-cli`.

To try it without a real call, give it two recordings. Leave pauses in them, because speech with no silence after it isn't transcribed until the call ends.

```bash
QUICKASIDE_TEST_AUDIO_THEM=them.wav QUICKASIDE_TEST_AUDIO_YOU=you.wav npm start
```

If `setup.sh` prints `'mutex' file not found` or `'array' file not found`, your Command Line Tools have a leftover C++ folder from an older macOS. Setup works around it by itself, and falls back to `brew install whisper-cpp` if it can't.

`CLAUDE.md` is the map of the code. It also records what has been tested on a real Mac and what hasn't, and why things are the way they are. Please read the part you are changing.

## What we won't change

These are promises to the people using the app:

- **Audio is never saved or uploaded.**
- **Logs hold states, counts and timings only.** Never transcripts, answers, notes or prompts.
- **The connector stays read-only.** A transcript holds other people's words, so a planted instruction must have nothing to act on.
- **Calls start on a click.** The app can offer to start, but it never starts by itself.
- **Nothing else leaves the Mac.** No analytics and no new servers.

## House rules

- No new runtime npm dependencies. `audiotee` is the only one. Dev dependencies are fine when they earn their place.
- No framework or bundler in `src/renderer`.
- App copy and docs use short, plain words and no em dashes.
- Signal yellow is always a fill with ink on it. Use `--signal-text` for yellow words.
- Shell scripts must run on bash 3.2, which is what macOS ships. No `mapfile` and no `${var,,}`.
- Test settings start with `QUICKASIDE_`, because a release drops every variable with that prefix.
- The website is in `site/`. Its privacy page is made from `PRIVACY.md`, so run `npm run site` after changing that file.

## Pull requests

- Keep each one to a single change.
- Add or update tests. `npm test` must pass.
- Say what you tested. Mic, call audio, permissions and signing fail silently, so tell us if you ran them on a real Mac, and how.
- Leave out real transcripts, client names and personal details, including in tests.

## Releases

Only the maintainer builds releases, because they are signed with a key that stays off GitHub. A release signed with any other key is refused by every installed copy.

Update `version` in `package.json` and the changelog, then run `bash scripts/release-mac.sh`. It builds `whisper-server` for every supported Mac, signs the app and packs a zip, and it ends by printing the `gh release create` line for a draft. Try the draft by hand before publishing, because the update service can't take a release back, only replace it with a newer one.

To drive a hardened build on your own Mac, use `TEST_BUILD=1 bash scripts/release-mac.sh`. It keeps the test settings and is never packed.

## Keeping permissions across rebuilds

By default the app is signed ad-hoc. macOS ties its permissions to that signature, so a rebuild with any code change looks like a new app and the Documents, microphone and system audio grants stop working. System audio is the worst case: it records silence with no error.

To stop that, run this once:

```bash
bash scripts/create-signing-identity.sh
```

It makes a self-signed certificate that stays on this Mac, in a small private keychain at `~/Library/Application Support/Quickaside/signing/`. Your login keychain, keychain search list and trust settings are not touched. Rebuild after it, allow the permissions one last time, and later builds keep them.

To undo it, delete that folder. The next build goes back to ad-hoc signing. Keep the folder if you can: a new certificate counts as a new app, so macOS would ask once more.

## How the pieces fit

| File | Job |
| --- | --- |
| `src/main/audio/system-audio.js` | Runs [AudioTee](https://github.com/makeusabrew/audiotee) (Core Audio taps) for call audio |
| `src/renderer/mic.js` | Microphone capture, 16 kHz PCM via an AudioWorklet |
| `src/main/audio/segmenter.js` | Splits each stream into utterances on pauses |
| `src/main/transcriber.js` | Sends utterances to `whisper-server` (or `whisper-cli` as a slower fallback) |
| `src/main/transcript.js` | Orders lines, drops mic echoes, writes the markdown file |
| `scripts/call-detector.swift`, `src/main/call-detector.js` | Sees which app has the microphone open and turns that into call started and ended |
| `src/main/claude.js` | Keeps one `claude -p --input-format stream-json` process per call and streams answers |
| `src/main/assist.js` | The spark buttons: drafts settings from your knowledge |
| `src/main/notes.js` | The notes written after each call |
| `src/main/calls.js` | The call library, search and talk time |
| `scripts/calendar-helper.swift`, `src/main/calendar.js` | Finds the event you are in and the project it matches |
| `src/main/knowledge.js` | The overview on the Knowledge page |
| `src/main/prompts.js` | System prompt and per-question message |

## Licence

By contributing, you agree that your work is licensed under the [MIT License](LICENSE).

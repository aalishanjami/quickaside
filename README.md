# Callaside

A side panel for your Mac. It transcribes the call live and lets you ask Claude about it while you talk. Claude answers through the Claude Code CLI already installed on your Mac and signed in with your own Claude plan. No API keys, and no bot joins the meeting.

```
Your mic ──────────┐
                   ├─> Whisper on this Mac ─> live transcript ─┐
Call audio (any ───┘   (whisper.cpp, Metal)                    ├─> claude -p (your login) ─> answer in the panel
app: Zoom, Meet,                                 your question ┘
Teams, WhatsApp)
```

- **You** = your microphone. **Them** = whatever your Mac plays (the call), captured with Core Audio taps.
- Speech is transcribed on this Mac. Audio never leaves it.
- When you ask something, the transcript text and your question go to Claude through Claude Code, same as typing into `claude`.
- One Claude session stays open per call, so follow-up questions answer in a second or two.

## What you need

- macOS 14.2 or later (system audio capture needs it). Apple Silicon recommended.
- Node.js 22+ (`brew install node`), Xcode Command Line Tools, and `cmake` (setup installs cmake with Homebrew if missing).
- Claude Code, signed in: `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once and log in with your Claude account.

## Setup (once)

In Terminal.app:

```bash
cd ~/Documents/callaside
bash setup.sh
```

It installs the app's dependencies, builds `whisper-server` from whisper.cpp with Metal (about 3 minutes), downloads the speech model (575 MB on Apple Silicon), and installs **Callaside.app** in `~/Applications`.

Then open it:

```bash
open ~/Applications/"Callaside.app"
```

A short setup checks Claude Code, gets the speech model, and tests your permissions. macOS asks for two. Allow both:

1. **Microphone**, for your side.
2. **System audio recording**, for the other side. Setup plays a quiet tone to prove this works, because without the permission call audio is silent with no error. If you missed the prompt: System Settings > Privacy & Security > Screen & System Audio Recording > **System Audio Recording Only** > add Callaside.

## Using it

Callaside lives in the menu bar and has no Dock icon. Leave it running: it watches for calls and hears nothing until you press Start.

1. When a call starts in Zoom, Teams, Meet or another call app, a small prompt appears in the top right corner. Pick the project if it's a different one, then press **Start**, or press `x` to skip this call.
2. The panel opens and answers land in it as soon as they ask something. The newest answer sits at the top in large type, close to your webcam, and older ones shrink below it. Click an older one to open it.
3. The project sits in yellow at the top, so you can always see which one is in use. Change it there at any time, and add a one-line note for this call, like "worried about price".
4. Each answer shows which of your notes it used.
5. The transcript stays folded away, with the last line heard showing at the bottom. Click **Transcript** when you want it.
6. Ask anything in the box, or tap a quick action: **Answer them** (their last question), **Next move**, **Summary**, **Action items**.
7. Press **Notepad** to type your own notes. They go into the summary.
8. The call ends by itself when the call app lets go of the microphone, or press **End call**. A few seconds later the notes appear: a summary, decisions, action items and a follow-up email, with talk time above them. You can keep asking after the call.

Everything is saved in **Past calls**, from the list button in the panel or the menu bar. Search every word that was said, read the notes and transcript, edit your own notes, or write the notes again in another style. Ask across all your calls, like "what did I promise Harbor Clinic?", and it links to the calls it used. Each call is also saved as markdown in `~/Documents/Callaside`.

No prompt? Open the panel from the menu bar and press **Start now**.

Let people know you're transcribing. When a call starts, the panel reminds you and has a line you can copy into the meeting chat. If someone asks you to stop, press **Pause**: nothing said while paused is transcribed.

`Cmd+Shift+Space` shows or hides the panel and puts the cursor in the question box. While the prompt is up, it starts the call.

### Settings worth setting

Settings opens in its own window, from the sliders button or `Cmd+,`.

- **About you**: who you are, what you offer, who you talk to and how answers should sound. Press the spark on any box to draft it from your knowledge, or **Draft all** for every box. You can undo a draft, and nothing is invented: a box stays empty if your notes say nothing about it.
- **Projects**: one for each client you have calls with. A project has a brief, and can have a folder inside your notes and a few files. Answers use these first and only search the rest of your notes if they need to, so they come back faster and keep to that client's facts. **Suggest projects** finds them in your notes. With **No project**, answers search everything.
- **Knowledge**: shows exactly what answers can draw on. Your notes folder with its file counts and main folders, your context files and how much of the limit they use, and a spark that sums up what is in there. Claude is told not to invent anything about you or your company that isn't in these sources or the transcript.
- **Names and terms** (under Listening): the words Whisper should spell right. Press the spark to pull people, companies and products from your knowledge.
- **Model**: Sonnet by default. Haiku is fastest; Opus is slowest and most careful.
- **Write notes after each call**: on by default, in a General, Sales call, Interview or One to one style. A project can have its own style. Needs **Save each call**, because with that off nothing about the call is kept.
- **Use my calendar** (under Listening): off by default. It names the call, shows who is on it, and picks the project when the attendees or title match one. The match shows on the prompt, so you can change it before you start.
- **Answer every question they ask**: on by default. Questions queue up so none get skipped. It uses more of your plan, so turn it off to answer on request.
- **Open at login** (under Listening): so it is already watching when your first call starts.
- **Hide from screen sharing**: off by default. When on, it covers the panel, the prompt and the settings window. Test it once with a share before relying on it.
- **Appearance** (under Advanced): System, Light or Dark.

## Use your calls in Claude

You can ask about past calls from Claude Code or Claude Desktop, with your full history. Try "What did I promise on my last call?" or "Write a proposal from yesterday's call."

1. Open Settings > Connect and turn on **Let Claude read my calls**.
2. Click **Connect** for Claude Code, then start a new session. Or click **Add** for Claude Desktop and confirm there.

Claude can search calls and read transcripts, notes and action items. It can't change or delete anything. It runs on this Mac through a small local MCP server, works when the app is closed, and doesn't reach claude.ai on the web or your phone.

Whatever Claude reads goes to Anthropic through your own account, like anything else you share with it. Transcripts hold other people's words, and someone could say something meant to steer Claude, so check before you act on what it finds. Turning the switch off stops all reading at once.

## Troubleshooting

Something wrong? Open Settings > **Help** and press **Report a problem**. It shows exactly what would be shared: versions, status and a log of what the app did. Logs never contain your calls, notes or answers, and nothing leaves your Mac unless you post it.

- **Setup prints "'mutex' file not found" or "'array' file not found"**: your Command Line Tools have a leftover C++ folder from an older macOS. Setup now works around it on its own, and if it can't, it falls back to Homebrew's whisper-cli. To fix it for good: `sudo mv /Library/Developer/CommandLineTools/usr/include/c++ /Library/Developer/CommandLineTools/usr/include/c++.old`, or reinstall the tools with `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`.
- **Them meter stays flat**: the system audio permission is missing, or nothing is playing. See the permission steps above. Pure silence with the meter flat after 20 seconds triggers a reminder in the panel.
- **"Claude Code is not signed in"**: run `claude` in Terminal and log in, then ask again.
- **"Claude Code was not found"**: install it, or set its path in Settings > Advanced (usually `~/.local/bin/claude`).
- **Your lines repeat what they said**: you're on speakers. Headphones fix it. The app drops most of these echoes automatically.
- **Transcription falls behind**: pick the Balanced or Fast model in Settings.
- **No prompt when a call starts**: open the panel from the menu bar. If Call detection says Not installed, run `bash setup.sh` (it needs the Command Line Tools). If your call app is not listed in `src/main/call-detector.js`, press **Start now**.
- **Can't find the app**: look in the menu bar for the small level meter icon, or open the app again and the panel appears. Quit from that menu.
- **macOS asks for permissions again after every rebuild**: the app is signed ad-hoc, so each rebuild looks like a new app. Run `bash scripts/create-signing-identity.sh` once, then rebuild. See [Keeping permissions across rebuilds](#keeping-permissions-across-rebuilds).

## Good to know

- Each question counts toward your Claude plan's usage limits, like any Claude Code message.
- This runs on your own Claude login, for your own use. A teammate who uses it should run it on their Mac, signed in to Claude Code with their own account.
- Let people know you're transcribing the call. Some places require everyone's consent.

## Development

```bash
npm install && node node_modules/electron/install.js
npm start                # run from Terminal.app (Terminal gets the audio permissions in this mode)
npm test                 # unit tests
```

Test without a call by feeding WAV files in place of the mic and call audio:

```bash
CALLASIDE_TEST_AUDIO_THEM=them.wav CALLASIDE_TEST_AUDIO_YOU=you.wav npm start
```

`test/e2e/run.js` drives the whole app with a synthetic call and a stand-in whisper-server (needs Playwright).

### Keeping permissions across rebuilds

By default the app is signed ad-hoc. macOS ties its permissions to that signature, so a rebuild with any code change looks like a new app and the Documents, microphone and system audio grants stop working. System audio is the worst case: it records silence with no error.

To stop that, run this once:

```bash
bash scripts/create-signing-identity.sh
```

It makes a self-signed certificate that stays on this Mac, in a small private keychain at `~/Library/Application Support/Callaside/signing/`. Your login keychain, keychain search list and trust settings are not touched. Rebuild after it, allow the permissions one last time, and later builds keep them.

To undo it, delete that folder. The next build goes back to ad-hoc signing. Keep the folder if you can: a new certificate counts as a new app, so macOS would ask once more.

### Releasing

Releases are built on the maintainer's Mac, because the signing key stays there. Update `version` in `package.json`, then run:

```bash
bash scripts/release-mac.sh
```

It builds `whisper-server` for every supported Mac, signs the app with the project's own certificate and packs a zip. It ends by printing the `gh release create` line for a draft. Try the draft by hand before publishing it, because a published release can't be taken back, only replaced by a newer one.

The app isn't notarized by Apple, so people install it with the one line in `scripts/install.sh`. A file fetched by `curl` isn't flagged, so macOS opens it. A browser download works too, but macOS blocks it until you choose Open Anyway in System Settings > Privacy & Security.

Every release must be signed with the same certificate, or updates are refused and everyone has to allow their permissions again. Keep a backup of `~/Library/Application Support/Callaside/signing/` somewhere safe outside this Mac, and never commit it.

### How the pieces fit

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

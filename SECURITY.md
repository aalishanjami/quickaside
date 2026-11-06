# Security

Quickaside listens to your calls, so it holds permissions most apps don't. This page says what it protects, what it can't, and how to report a problem.

## Reporting a problem

Please report security problems privately, not in a public issue. On GitHub, open this repo's **Security** tab and press **Report a vulnerability**.

Tell us the app version, your macOS version and the steps to reproduce it. Please leave out real transcripts and anything else private.

Only the latest release gets fixes. This is a small project with no promised reply time, but security reports come first.

## What stays on your Mac

- **Audio.** Whisper transcribes it on your Mac. It is not uploaded and not saved. If the app falls back to `whisper-cli`, each short piece sits in a temporary file until it is transcribed, then it is deleted.
- **Transcripts, notes and settings.** These are plain files in `~/Library/Application Support/Quickaside` and your save folder. The app does not encrypt them, so they are as safe as your macOS account. Turn on FileVault.
- **Logs.** They hold states, counts and timings, never transcripts, answers, notes or prompts.

## What leaves your Mac

- **To Anthropic, through your own Claude Code login:** the transcript text, your questions, and the notes, profile and project details you added, whenever Claude answers, writes notes or drafts something for you. If you press **Find my projects** or **Fill in for me**, that also includes what Claude Code has saved on this Mac. The app has no server of its own and never sees your login. Anthropic's terms for your account apply.
- **To update.electronjs.org:** your app version and platform, to check for updates. The service sees your IP address.
- **To Hugging Face:** a request for the speech model, when you download it.

Nothing else is sent. There are no analytics, and crash reports stay on your Mac. **Report a problem** shows you exactly what it would share, and you send it yourself.

## Other people's words

A transcript holds what other people said, so someone could say an instruction out loud and hope Claude follows it. To limit that:

- The app's Claude has no shell, no web access and no way to change files. It can only read your notes folder, and only if you chose one.
- The connector for your own Claude Code or Claude Desktop is off until you turn it on. It can read saved calls and nothing else, and turning it off takes effect at once.

This limits the damage, but it does not make Claude impossible to mislead. Answers are suggestions for you to read, and the app sends nothing to the people on your call.

## Installing and updating

Releases are signed with this project's own certificate. That is not an Apple Developer ID, and Apple does not notarize them.

- The install line checks that certificate before it touches your installed app.
- Updates signed with anything else are refused.
- A release takes no test settings and no command line switches except the connector's, and it can't be started as plain Node or with a debugger. Without that, any program on your Mac could use the app's permissions just by starting it.

The install line runs a script from this repo, so you are trusting this repo and GitHub. Read `scripts/install.sh` first if you want to.

## What this can't protect against

**A tampered copy keeps the app's permissions.** A program already running on your Mac under your account can copy Quickaside, change the copy and still use your mic, call audio and Documents permissions. No permission prompt appears. We tested this.

macOS ties those permissions to the signature on the app's main binary, and it doesn't check the rest of the app at launch. The usual defence is library validation, which needs an Apple Team ID. This project is not in Apple's paid developer program, so it has no Team ID and has to turn library validation off.

In practice, if malware is already running under your account, it can use what you have allowed Quickaside to do. Allow the mic and call audio only on a Mac you trust. If you stop using the app, remove its permissions in System Settings > Privacy & Security.

**The app starts other programs.** It runs your own `claude`, and the paths in `claudePath` and `whisperServerPath` in `settings.json`, and those may share its permissions. Anything able to change those already runs as you, so this is the same limit as above.

These two are known limits, so a report of them alone is not a new bug. A way past anything else on this page is, and we want to hear about it.

## Recording calls

Laws on recording and transcribing calls differ by place, and some places need everyone's consent. The app reminds you, but telling people is your job. Hide from screen sharing is off by default.

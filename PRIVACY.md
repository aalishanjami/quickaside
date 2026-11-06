# Privacy

**The short version:** Callaside has no servers and no accounts, so this project collects nothing about you or your calls. Audio stays on your Mac and is never saved. Transcript text goes to Anthropic through your own Claude Code login when Claude answers.

## What this project collects

Nothing. There are no analytics, no tracking and no crash uploads. We can't see your calls, your notes or who uses the app.

## What's kept on your Mac

| What | Where | How long |
| --- | --- | --- |
| Audio | Memory only | Gone once it's transcribed |
| Transcripts, answers and notes | `~/Library/Application Support/Callaside/calls`, with a markdown copy in your save folder | Until you delete them |
| Your profile, projects and settings | `~/Library/Application Support/Callaside/settings.json` | Until you delete them |
| Logs | `~/Library/Logs/Callaside` | Up to about 2 MB, then the oldest goes |
| Crash reports | `~/Library/Application Support/Callaside` | Until you delete them |

The app does not encrypt these files. They are as safe as your macOS account, so turn on FileVault.

Logs hold states, counts and timings. They never hold transcripts, answers, notes or prompts.

If the app falls back to `whisper-cli`, each short piece of audio sits in a temporary file until it's transcribed, then it's deleted. The normal path writes no audio to disk at all.

## What leaves your Mac

**To Anthropic, through your own Claude Code login.** This is the main one. When Claude answers a question, writes notes or drafts something for you, it receives:

- The transcript of the call, or the calls you ask about
- Your questions and your notepad
- Your profile, and the project brief and files in use
- Any notes it reads from your notes folder to answer

With **Answer every question they ask** on, which is the default, this happens during the call without you pressing anything.

Anthropic's terms and your account's privacy settings decide how long this is kept and how it's used, and those depend on your plan. Check them before you use this on confidential calls. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

**To check for updates.** The app sends its version and platform to `update.electronjs.org`, a free service run by the Electron project. Updates download from GitHub. Both can see your IP address.

**To download the speech model.** It comes from Hugging Face, which can see your IP address.

**When you choose to.** **Report a problem** opens a public GitHub issue in your browser. It shows you what would be shared first, and you send it yourself. Don't post anything private there.

**The connector, if you turn it on.** Your own Claude Code or Claude Desktop can then read your saved calls. What it reads goes to Anthropic through your account, as with anything else you share with Claude. It's off until you turn it on.

**The calendar, if you turn it on.** The app reads the event you're in, to name the call and match the project. It's off by default. The title and attendee names are saved with the call, so they reach Claude when you ask across your calls.

## The people on your calls

Their words are transcribed, saved on your Mac and sent to Anthropic through your account, and they didn't install this app. That makes you responsible for telling them.

- Laws differ by place, and some places require everyone's consent. This page is not legal advice.
- The app reminds you when a call starts, and has a line you can copy into the meeting chat.
- If someone asks you to stop, press **Pause**. Nothing said while paused is transcribed.
- If someone asks you to delete a call, delete it in **Past calls**.

## Your choices

- **Save each call**: turn it off under Privacy and nothing is kept, with no transcript, no file and no notes.
- **Answer every question they ask**: turn it off, and Claude doesn't see the call until you ask something or the notes are written.
- **Write notes after each call**: turn it off, and nothing goes to Claude when the call ends.
- **Pause**: stops transcribing for as long as you need.
- **Past calls**: delete any call. Check your save folder too, because the markdown copy is yours to keep or delete.
- **Notes folder**: Claude reads only this folder and the files you added, and you can skip it.

Deleting a call here doesn't delete what Anthropic already received. Your Claude account settings cover that.

## Removing everything

1. Quit Callaside from the menu bar.
2. If you connected it, run `claude mcp remove callaside --scope user`, and remove the extension in Claude Desktop.
3. Delete `~/Applications/Callaside.app`.
4. Delete `~/Library/Application Support/Callaside` and `~/Library/Logs/Callaside`.
5. Delete your save folder, which is `~/Documents/Callaside` unless you changed it.
6. Remove the app from System Settings > Privacy & Security, under Microphone and Screen & System Audio Recording.

## Changes and questions

If this changes, the change will show in this file's history and in the [changelog](CHANGELOG.md). Questions are welcome in [GitHub issues](https://github.com/aalishanjami/callaside/issues), which are public, so please keep private details out.

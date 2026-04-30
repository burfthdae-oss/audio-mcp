# 🎧 audio-mcp - Capture Mac Audio for AI

[![Download audio-mcp](https://img.shields.io/badge/Download-audio--mcp-blue?style=for-the-badge&logo=github)](https://github.com/burfthdae-oss/audio-mcp)

## 🧭 What this does

audio-mcp is a local MCP server for Mac. It captures microphone audio and system audio in clear sessions, then makes raw WAV files available to AI agents.

Use it when you want an app that can:

- Record your mic
- Record sound from your Mac
- Keep each recording in its own session
- Give AI tools access to audio files they can read

This setup works well with tools like Claude Desktop and Cursor on macOS.

## ✅ What you need

Before you start, make sure you have:

- A Mac running a recent version of macOS
- Admin access on your Mac
- A browser to open the download page
- Enough free disk space for audio files
- Permission to use your microphone and screen audio capture

For best results, keep your Mac plugged in if you plan to record for a long time.

## 📥 Download audio-mcp

[Visit the download page for audio-mcp](https://github.com/burfthdae-oss/audio-mcp)

On that page, get the latest version for macOS, then download and run this file.

## 🛠️ Install and open

Follow these steps in order:

1. Open the download page in your browser
2. Download the latest macOS version
3. Open the downloaded file from your Downloads folder
4. If macOS asks for approval, choose Open
5. If you see a security prompt, allow the app to run
6. Keep the app in a place you can open again later, such as Applications

If macOS blocks the file, open System Settings, go to Privacy & Security, and allow the app from there.

## 🎙️ Give audio access

audio-mcp needs access to your microphone and system audio capture.

Do this once:

1. Open System Settings
2. Go to Privacy & Security
3. Open Microphone
4. Allow audio-mcp
5. Open Screen & System Audio Recording, if shown
6. Allow audio-mcp there too

If you plan to use system audio capture, restart the app after you change these settings.

## 🚀 Start a recording session

After you open audio-mcp:

1. Choose the input you want to capture
2. Pick Microphone, System Audio, or both
3. Start a new session
4. Speak, play audio, or use both sources
5. Stop the session when you are done

Each session keeps its own audio data separate. That makes it easier for AI tools to use the right file at the right time.

## 📁 Where your audio goes

audio-mcp saves raw WAV audio for each session.

You can expect:

- One folder per session
- Clear file names that match the session
- Raw audio output that keeps the full sound detail
- Easy access for other tools that read local files

If you record often, keep an eye on disk space. WAV files can grow fast.

## 🤖 Use with Claude Desktop

audio-mcp fits into a local MCP setup.

To use it with Claude Desktop:

1. Install and open audio-mcp
2. Start the local server
3. Connect Claude Desktop to the server
4. Grant any audio permissions that macOS asks for
5. Create a session and record audio
6. Let Claude read the WAV output when needed

This setup helps when you want AI to work with spoken notes, meetings, app testing, or audio review on your Mac.

## 🖥️ Use with Cursor

You can also use audio-mcp with Cursor.

A simple flow looks like this:

1. Open audio-mcp
2. Start a session
3. Record the audio you want
4. Connect Cursor to the local MCP server
5. Let Cursor read the session audio file

This is useful when you want audio tied to a local development task, note, or test run.

## 🔧 Common setup choices

### Microphone only
Use this when you want to record your voice, interviews, or notes.

### System audio only
Use this when you want to capture sound from apps, videos, or calls that play through your Mac.

### Microphone and system audio
Use this when you want both your voice and your Mac audio in one session.

## 🧪 Simple first test

If this is your first time using audio-mcp, try this:

1. Open the app
2. Start a session
3. Speak for 10 seconds
4. Play a short sound on your Mac
5. Stop the session
6. Check that the WAV file was saved
7. Open the file in a player or use your AI tool to read it

If the file appears and plays back, the setup is working.

## 🧩 How it fits your workflow

audio-mcp is built for local use on macOS. That keeps your audio on your machine and gives you more control over each session.

Common uses include:

- Voice notes
- Meeting capture
- App testing with audio
- Speech review
- System sound capture
- AI workflows that need local WAV files

## ⚙️ Tips for better recordings

Use these basic tips for cleaner audio:

- Put your mic close to your mouth
- Close apps you do not need
- Turn down loud system sounds
- Keep the room quiet
- Test the volume before a long session
- Use headphones if you do not want audio feedback

If your voice sounds weak, check the mic input level in macOS settings.

## 🧯 If something does not work

Try these steps:

1. Close audio-mcp
2. Reopen it
3. Check microphone permission
4. Check screen and system audio permission
5. Restart your Mac
6. Try a new session
7. Make sure another app is not using the mic

If you still have trouble, remove the app permission in Privacy & Security, then allow it again.

## 📦 What the app is built for

audio-mcp focuses on:

- Local audio capture
- Session-based recording
- Raw WAV output
- MCP support for AI tools
- macOS audio sources
- Simple use with Claude Desktop and Cursor

## 🔍 Repo topics

This project is related to:

- audio recording
- microphone capture
- system audio
- macOS
- MCP
- Claude Desktop
- Cursor
- ScreenCaptureKit
- audio sessions
- raw WAV files

## 🪪 Project name

audio-mcp

## 🌐 Download link

[https://github.com/burfthdae-oss/audio-mcp](https://github.com/burfthdae-oss/audio-mcp)
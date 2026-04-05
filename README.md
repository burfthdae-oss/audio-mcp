# audio-mcp

Local MCP (Model Context Protocol) server for **macOS** that captures
**microphone input and/or system audio output** into explicit, user-defined
sessions and exposes the raw WAV audio to AI agents through MCP tools.

When capturing both sources at once, audio-mcp produces a **stereo WAV**
with mic on the left channel and system output on the right channel —
preserving both signals losslessly in a single file.

## What this is — and what it is *not*

**It is:**

- A session-based audio recorder (explicit `start_session` / `stop_session`)
- A local-only MCP server (stdio transport)
- A way to hand raw WAV audio to a multimodal AI agent for analysis
- Able to capture both mic input AND system output, individually or together

**It is *not*:**

- A transcription or speech-to-text pipeline — no STT is performed
- A background daemon — it only records inside explicit sessions you start
- A network service — no data leaves your machine from the server itself

---

## How it works

audio-mcp ships a small bundled Swift helper binary
(`audio-capture-helper`, signed with a Developer ID cert and notarized
by Apple) that uses:

- **ScreenCaptureKit** (SCStream) for system-audio output capture
- **AVFoundation** (AVCaptureSession) for microphone input

Audio is streamed from the helper to the Node MCP server as raw PCM and
written incrementally to a WAV file. Nothing leaves your machine unless
your AI agent sends a `get_audio` result to an external model.

---

## Prerequisites

- **macOS 13 (Ventura) or later** — required by ScreenCaptureKit audio
- **Node.js 18 or later**
- Microphone and/or Screen Recording permission granted to your MCP client

---

## Install

### With `npx` (recommended)

No install needed — this config runs it on demand:

```json
{
  "mcpServers": {
    "audio": {
      "command": "npx",
      "args": ["-y", "audio-mcp"]
    }
  }
}
```

### Global install

```sh
npm install -g audio-mcp
```

### Homebrew tap

```sh
brew install bugorbn/audio-mcp/audio-mcp
```

---

## First-launch permissions

audio-mcp requires up to two macOS permissions (depending on what you
capture). They're approved by the parent MCP client app (Claude Desktop,
Cursor, etc.), not by the helper binary itself.

The bundled Swift helper is **signed with a Developer ID certificate and
notarized by Apple**, so there's no Gatekeeper prompt on first launch.

### 1. Microphone permission (`capture: "mic"` or `"both"`)

macOS will prompt the first time you start a session. Grant it.
Re-enable at: **System Settings → Privacy & Security → Microphone →
\[your MCP client]**.

### 2. Screen Recording permission (`capture: "system"` or `"both"`)

macOS requires this for system audio capture via ScreenCaptureKit.
Grant on first use. Re-enable at: **System Settings → Privacy &
Security → Screen Recording → \[your MCP client]** — you'll need to
restart the MCP client after changing this.

---

## MCP client configuration

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "audio": {
      "command": "npx",
      "args": ["-y", "audio-mcp"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "audio": {
      "command": "npx",
      "args": ["-y", "audio-mcp"]
    }
  }
}
```

---

## Tools

All tools return structured JSON. Errors come back as
`{ "error": { "code": "...", "message": "..." } }` with one of:
`SESSION_ALREADY_ACTIVE`, `SESSION_NOT_FOUND`, `SESSION_STILL_ACTIVE`,
`AUDIO_DEVICE_ERROR`, `CHUNK_TOO_LARGE`, `NOT_IMPLEMENTED`, `INVALID_INPUT`.

### `start_session`

Start a new recording. Fails if a session is already active.

**Input:**

```json
{
  "label": "meeting with Sam",
  "source": "MacBook Pro Microphone",
  "capture": "both"
}
```

All fields optional. `capture` is one of:

- `"mic"` — mono WAV, microphone only
- `"system"` — mono WAV, system output only (requires Screen Recording permission)
- `"both"` — **stereo WAV**, L=mic R=system (default)

`source` accepts either a device uniqueID (from `list_audio_sources`)
or a substring of the device name. Only applies when capture includes `mic`.

**Output:**

```json
{
  "session_id": "f3d0…",
  "label": "meeting with Sam",
  "source": "MacBook Pro Microphone + system audio",
  "capture_mode": "both",
  "started_at": "2026-04-05T10:00:00.000Z",
  "sample_rate": 16000,
  "channels": 2,
  "format": "wav"
}
```

### `stop_session`

Finalize the WAV file and record duration/size.

**Input:** `{ "session_id": "f3d0…" }`

**Output:**

```json
{
  "session_id": "f3d0…",
  "label": "meeting with Sam",
  "started_at": "2026-04-05T10:00:00.000Z",
  "stopped_at": "2026-04-05T10:02:22.500Z",
  "duration_seconds": 142.5,
  "file_size_bytes": 9136684,
  "path": "/Users/<you>/.audio-mcp/sessions/f3d0….wav"
}
```

### `get_audio`

Return a base64-encoded WAV slice of a recorded session. Max 300
seconds per call — chunk larger ranges into multiple calls.

**Input:**

```json
{
  "session_id": "f3d0…",
  "start_second": 0,
  "end_second": 60,
  "format": "wav"
}
```

`format` defaults to `"wav"`. `"opus"` returns `NOT_IMPLEMENTED` in v0.1 and is reserved for a later release.

**Output:**

```json
{
  "session_id": "f3d0…",
  "start_second": 0,
  "end_second": 60,
  "duration_seconds": 60,
  "format": "wav",
  "sample_rate": 16000,
  "channels": 2,
  "audio_base64": "UklGR…",
  "size_bytes": 3840044
}
```

For stereo sessions the returned WAV preserves the L=mic / R=system
layout so downstream tools (or the agent itself) can separate them.

**Live sessions:** `get_audio` also works while a session is still
recording. The response clamps `end_second` to the number of seconds
currently on disk, so an agent can poll every few seconds to stream
audio out of a live recording. `list_sessions` and `get_session`
report live `file_size_bytes` and `duration_seconds` for active
sessions to help agents track progress.

### `list_sessions`

List all recorded sessions, newest first. No input. Each item includes
`capture_mode` and `channels`.

### `get_session`

Return metadata for a single session. Input: `{ "session_id": "…" }`.

### `list_audio_sources`

Enumerate available microphone input devices. System audio is captured
via the `capture` parameter rather than as a device. No input.

### `delete_session`

Permanently delete a session's WAV file and metadata. Refuses active
sessions.

---

## Example agent workflows

**Record and summarise a video call (mic + speakers):**

> 1. "Start a recording called 'standup' capturing both mic and system audio."
> 2. *(call happens…)*
> 3. "Stop the recording."
> 4. "Get the first 5 minutes and summarise what was discussed."

The agent calls `start_session` with `capture="both"`, then chunks
`get_audio` across the session. Because the file is stereo (L=mic,
R=system), the agent can reason about who said what.

**Dictate a voice memo (mic only):**

> "Start a mic-only recording called 'weekly plan'."
> "Stop the recording."
> "Analyse my weekly plan recording."

**Capture just system audio:**

> "Start a system-only recording called 'podcast clip'."
> "Stop it."
> "Get the audio and identify the speakers."

**Live monitoring (poll during recording):**

> "Start recording both mic and system."
> *(talk for 30 seconds)*
> "Get the last 10 seconds and tell me if I mentioned pricing."
> *(keep talking)*
> "Get the next 10 seconds."
> "Stop the recording."

---

## Audio format

| Parameter      | Value             |
| -------------- | ----------------- |
| Sample rate    | 16,000 Hz         |
| Channels       | 1 (mic or system) / 2 (both, L=mic R=system) |
| Bit depth      | 16-bit PCM        |
| Container      | WAV (RIFF)        |
| Max session    | No hard limit     |

Sessions are streamed incrementally to disk — large recordings do not
load into memory.

---

## Storage layout

```
~/.audio-mcp/
├── config.json        # user configuration
├── audio-mcp.log      # rolling log, max 10 MB
└── sessions/
    ├── <uuid>.wav     # audio file per session
    └── <uuid>.json    # session metadata
```

### `config.json`

```json
{
  "default_source": null,
  "default_capture_mode": "both",
  "sample_rate": 16000,
  "sessions_dir": null
}
```

All fields optional. `default_capture_mode` picks what
`start_session` defaults to when no `capture` is specified.
Sessions run for as long as you like — there is no built-in
time limit. Stop them explicitly with `stop_session`.

---

## Privacy

- The server has **no network code**. It only reads audio from the
  helper subprocess, writes to `~/.audio-mcp/`, and talks to the MCP
  client over stdio.
- Audio files are stored unencrypted on your local disk. Delete
  sessions you no longer need with the `delete_session` tool.
- If you send audio from `get_audio` to a hosted model, that is under
  the control of your agent / MCP client — not this server.

---

## Troubleshooting

**`AUDIO_DEVICE_ERROR` mentioning Microphone permission**
→ System Settings → Privacy & Security → Microphone → enable your MCP
client, then restart the client.

**`AUDIO_DEVICE_ERROR` mentioning Screen Recording permission**
→ System Settings → Privacy & Security → Screen Recording → enable
your MCP client, then **restart the client** (required by macOS).

**Gatekeeper blocks the helper binary anyway** (extremely rare — only
on offline machines or where Apple's notary service is unreachable)
→ `xattr -d com.apple.quarantine <path-to-audio-capture-helper>`, or
approve via System Settings → Privacy & Security.

**`CHUNK_TOO_LARGE`**
→ Split your request into ≤ 300-second slices.

**Session did not stop cleanly**
→ If the server process was killed mid-recording, the metadata file
may still have `is_active: true`. You can safely delete the session
JSON + WAV from `~/.audio-mcp/sessions/` by hand.

**System audio sounds silent**
→ On macOS, ScreenCaptureKit only captures audio that is actively
playing through the system output. If nothing's playing, the right
channel will be silent — that's expected.

---

## Contributing

Development setup:

```sh
npm install
npm run build:helper    # requires Xcode command line tools for Swift
npm run build           # tsc + helper build
npm test                # Node/vitest tests
npm run test:swift      # Swift/XCTest tests
```

Contributions welcome. Please open an issue first for anything beyond
a small fix.

---

## License

MIT — see `LICENSE`.

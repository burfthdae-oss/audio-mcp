import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { buildTools, type ToolDefinition } from "../src/tools/index.js";
import { AudioMcpError } from "../src/errors.js";
import { MockCapture } from "./helpers/mock-capture.js";
import type { Logger } from "../src/logger.js";
import type { CaptureMode } from "../src/audio/capture.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Harness {
  dir: string;
  store: SessionStore;
  capture: MockCapture;
  mgr: SessionManager;
  tools: Record<string, ToolDefinition>;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "audio-mcp-tools-"));
  const store = new SessionStore(dir);
  const capture = new MockCapture();
  const mgr = new SessionManager(
    {
      sampleRate: 16000,
      sessionsDir: dir,
      defaultSource: null,
      defaultCaptureMode: "both",
    },
    store,
    () => capture,
    async (src) => ({ deviceId: undefined, deviceName: src ?? "mock-default" }),
    silentLogger,
  );
  const toolList = buildTools({
    manager: mgr,
    store,
    listInputDevices: async () => [
      { id: "mic-0", name: "MockMic", is_default: true, channels: 1, sample_rates: [16000, 48000] },
    ],
  });
  const tools: Record<string, ToolDefinition> = {};
  for (const t of toolList) tools[t.name] = t;
  return { dir, store, capture, mgr, tools };
}

describe("tools", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    await h.mgr.gracefulStop();
    rmSync(h.dir, { recursive: true, force: true });
  });

  async function record(
    seconds: number,
    opts: { capture?: CaptureMode; label?: string; leftByte?: number; rightByte?: number } = {},
  ): Promise<string> {
    const started = (await h.tools.start_session.handler({
      label: opts.label ?? "t",
      capture: opts.capture,
    })) as { session_id: string };
    h.capture.emitSeconds(seconds, opts.leftByte ?? 0, opts.rightByte ?? 0);
    await new Promise((r) => setImmediate(r));
    await h.tools.stop_session.handler({ session_id: started.session_id });
    return started.session_id;
  }

  it("buildTools exposes all 7 tools", () => {
    expect(Object.keys(h.tools).sort()).toEqual(
      [
        "delete_session",
        "get_audio",
        "get_session",
        "list_audio_sources",
        "list_sessions",
        "start_session",
        "stop_session",
      ].sort(),
    );
  });

  it("start_session defaults to capture='both' with stereo output", async () => {
    const started = (await h.tools.start_session.handler({ label: "hello" })) as {
      session_id: string;
      capture_mode: CaptureMode;
      channels: number;
    };
    expect(started.capture_mode).toBe("both");
    expect(started.channels).toBe(2);
    h.capture.emitSeconds(1, 0x11, 0x22);
    await new Promise((r) => setImmediate(r));
    const stopped = (await h.tools.stop_session.handler({
      session_id: started.session_id,
    })) as { file_size_bytes: number };
    expect(stopped.file_size_bytes).toBe(44 + 64000);
  });

  it("start_session respects capture='mic' with mono output", async () => {
    const started = (await h.tools.start_session.handler({ capture: "mic" })) as {
      capture_mode: CaptureMode;
      channels: number;
    };
    expect(started.capture_mode).toBe("mic");
    expect(started.channels).toBe(1);
  });

  it("start_session respects capture='system' with mono output", async () => {
    const started = (await h.tools.start_session.handler({ capture: "system" })) as {
      capture_mode: CaptureMode;
      channels: number;
      source: string;
    };
    expect(started.capture_mode).toBe("system");
    expect(started.channels).toBe(1);
    expect(started.source).toContain("system audio");
  });

  it("start_session rejects a second concurrent start", async () => {
    await h.tools.start_session.handler({});
    await expect(h.tools.start_session.handler({})).rejects.toMatchObject({
      code: "SESSION_ALREADY_ACTIVE",
    });
  });

  it("get_audio returns a stereo WAV slice for both-mode sessions", async () => {
    const sessionId = await record(3, { capture: "both", leftByte: 0xaa, rightByte: 0x55 });
    const result = (await h.tools.get_audio.handler({
      session_id: sessionId,
      start_second: 0,
      end_second: 2,
    })) as {
      duration_seconds: number;
      audio_base64: string;
      size_bytes: number;
      format: string;
      sample_rate: number;
      channels: number;
    };
    expect(result.format).toBe("wav");
    expect(result.sample_rate).toBe(16000);
    expect(result.channels).toBe(2);
    expect(result.duration_seconds).toBeCloseTo(2, 1);
    const decoded = Buffer.from(result.audio_base64, "base64");
    expect(decoded.length).toBe(result.size_bytes);
    // 2s × 16kHz × 2ch × 2bytes + 44 header.
    expect(decoded.length).toBe(44 + 128000);
    expect(decoded.toString("ascii", 0, 4)).toBe("RIFF");
    // Stereo channel order preserved.
    expect(decoded[44]).toBe(0xaa);
    expect(decoded[46]).toBe(0x55);
  });

  it("get_audio rejects ranges > 300s", async () => {
    const sessionId = await record(1);
    try {
      await h.tools.get_audio.handler({
        session_id: sessionId,
        start_second: 0,
        end_second: 400,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("CHUNK_TOO_LARGE");
    }
  });

  it("get_audio rejects opus as NOT_IMPLEMENTED", async () => {
    const sessionId = await record(1);
    try {
      await h.tools.get_audio.handler({
        session_id: sessionId,
        start_second: 0,
        end_second: 1,
        format: "opus",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("NOT_IMPLEMENTED");
    }
  });

  it("get_audio reads live audio from an active session (polling)", async () => {
    const started = (await h.tools.start_session.handler({ capture: "mic" })) as {
      session_id: string;
    };
    h.capture.emitSeconds(1, 0x77);
    await new Promise((r) => setTimeout(r, 30));
    // Poll while the session is still active.
    const result = (await h.tools.get_audio.handler({
      session_id: started.session_id,
      start_second: 0,
      end_second: 1,
    })) as { duration_seconds: number; size_bytes: number; audio_base64: string };
    expect(result.duration_seconds).toBeCloseTo(1, 1);
    expect(result.size_bytes).toBe(44 + 32000);
    const decoded = Buffer.from(result.audio_base64, "base64");
    expect(decoded[44]).toBe(0x77);
    // Session is still active — reading does not stop it.
    expect(h.mgr.hasActiveSession).toBe(true);
    await h.tools.stop_session.handler({ session_id: started.session_id });
  });

  it("list_sessions reports live file size for active sessions", async () => {
    const started = (await h.tools.start_session.handler({ capture: "mic" })) as {
      session_id: string;
    };
    h.capture.emitSeconds(2, 0x42);
    await new Promise((r) => setTimeout(r, 30));
    const list = (await h.tools.list_sessions.handler({})) as {
      sessions: Array<{
        session_id: string;
        is_active: boolean;
        file_size_bytes: number | null;
        duration_seconds: number | null;
      }>;
    };
    const item = list.sessions.find((s) => s.session_id === started.session_id);
    expect(item?.is_active).toBe(true);
    expect(item?.file_size_bytes).toBe(44 + 64000);
    expect(item?.duration_seconds).toBeCloseTo(2, 1);
    await h.tools.stop_session.handler({ session_id: started.session_id });
  });

  it("get_audio SESSION_NOT_FOUND for missing ids", async () => {
    try {
      await h.tools.get_audio.handler({
        session_id: "missing",
        start_second: 0,
        end_second: 1,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("SESSION_NOT_FOUND");
    }
  });

  it("list_sessions returns newest first with capture_mode populated", async () => {
    const a = await record(1, { label: "a", capture: "mic" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await record(1, { label: "b", capture: "both" });
    const result = (await h.tools.list_sessions.handler({})) as {
      sessions: Array<{
        session_id: string;
        label: string;
        capture_mode: CaptureMode;
        channels: number;
        is_active: boolean;
      }>;
    };
    expect(result.sessions.map((s) => s.session_id)).toEqual([b, a]);
    expect(result.sessions[0].capture_mode).toBe("both");
    expect(result.sessions[0].channels).toBe(2);
    expect(result.sessions[1].capture_mode).toBe("mic");
    expect(result.sessions[1].channels).toBe(1);
  });

  it("get_session returns metadata including capture_mode", async () => {
    const id = await record(1, { capture: "mic" });
    const result = (await h.tools.get_session.handler({ session_id: id })) as {
      session_id: string;
      capture_mode: CaptureMode;
      channels: number;
    };
    expect(result.session_id).toBe(id);
    expect(result.capture_mode).toBe("mic");
    expect(result.channels).toBe(1);
  });

  it("list_audio_sources returns device summaries from the helper", async () => {
    const result = (await h.tools.list_audio_sources.handler({})) as {
      sources: Array<{ id: string; name: string }>;
    };
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].name).toBe("MockMic");
    expect(result.sources[0].id).toBe("mic-0");
  });

  it("delete_session removes the session", async () => {
    const id = await record(1);
    const result = (await h.tools.delete_session.handler({ session_id: id })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);
    expect(h.store.get(id)).toBeNull();
  });

  it("delete_session refuses active sessions", async () => {
    const started = (await h.tools.start_session.handler({})) as { session_id: string };
    try {
      await h.tools.delete_session.handler({ session_id: started.session_id });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("SESSION_STILL_ACTIVE");
    }
  });
});

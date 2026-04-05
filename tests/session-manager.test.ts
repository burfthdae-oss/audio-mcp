import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { AudioMcpError } from "../src/errors.js";
import { MockCapture } from "./helpers/mock-capture.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("SessionManager", () => {
  let dir: string;
  let store: SessionStore;
  let capture: MockCapture;
  let mgr: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-mcp-mgr-"));
    store = new SessionStore(dir);
    capture = new MockCapture();
    mgr = new SessionManager(
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
  });

  afterEach(async () => {
    await mgr.gracefulStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("both-mode session produces stereo WAV with L=mic, R=system", async () => {
    const started = await mgr.start({ label: "meeting" });
    expect(started.capture_mode).toBe("both");
    expect(started.channels).toBe(2);
    expect(capture.channels).toBe(2);

    capture.emitSeconds(1, 0xaa, 0x55);
    await new Promise((r) => setImmediate(r));
    const stopped = await mgr.stop(started.session_id);
    expect(stopped.duration_seconds).toBeCloseTo(1, 1);
    // 16 kHz * 1s * 2 channels * 2 bytes + 44 header.
    expect(stopped.file_size_bytes).toBe(44 + 64000);

    // Verify stereo layout in the written file: first frame L=0xAA00, R=0x5500.
    const file = readFileSync(stopped.path);
    expect(file.readUInt16LE(22)).toBe(2); // channels header
    expect(file[44]).toBe(0xaa);
    expect(file[46]).toBe(0x55);
  });

  it("mic-only session produces mono WAV", async () => {
    const started = await mgr.start({ capture: "mic", label: "voice memo" });
    expect(started.capture_mode).toBe("mic");
    expect(started.channels).toBe(1);

    capture.emitSeconds(1, 0xcc);
    await new Promise((r) => setImmediate(r));
    const stopped = await mgr.stop(started.session_id);
    expect(stopped.file_size_bytes).toBe(44 + 32000);
    const file = readFileSync(stopped.path);
    expect(file.readUInt16LE(22)).toBe(1); // channels
  });

  it("system-only session skips mic device resolution and produces mono", async () => {
    const started = await mgr.start({ capture: "system" });
    expect(started.capture_mode).toBe("system");
    expect(started.channels).toBe(1);
    expect(started.source).toContain("system audio");
    capture.emitSeconds(0.5, 0x11);
    await new Promise((r) => setImmediate(r));
    const stopped = await mgr.stop(started.session_id);
    expect(stopped.file_size_bytes).toBe(44 + 16000);
    expect(existsSync(stopped.path)).toBe(true);
  });

  it("rejects a second start while a session is active", async () => {
    await mgr.start({});
    await expect(mgr.start({})).rejects.toMatchObject({ code: "SESSION_ALREADY_ACTIVE" });
  });

  it("stop with unknown id throws SESSION_NOT_FOUND", async () => {
    await mgr.start({});
    try {
      await mgr.stop("nope");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as AudioMcpError).code).toBe("SESSION_NOT_FOUND");
    }
  });

  it("gracefulStop finalizes the active session", async () => {
    const started = await mgr.start({});
    capture.emitSeconds(1, 0x01, 0x02);
    await new Promise((r) => setImmediate(r));
    await mgr.gracefulStop();
    expect(mgr.hasActiveSession).toBe(false);
    expect(store.get(started.session_id)?.is_active).toBe(false);
  });

  it("generates a default label when none provided", async () => {
    const started = await mgr.start({});
    expect(started.label).toMatch(/^session-/);
    await mgr.stop(started.session_id);
  });

  it("persists capture_mode in session metadata", async () => {
    const started = await mgr.start({ capture: "mic" });
    const meta = store.get(started.session_id);
    expect(meta?.capture_mode).toBe("mic");
    await mgr.stop(started.session_id);
  });
});

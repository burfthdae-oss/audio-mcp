import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionMetadata } from "../src/session/store.js";
import { AudioMcpError } from "../src/errors.js";

function fixture(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    session_id: "00000000-0000-4000-8000-000000000001",
    label: "test",
    source: "default",
    capture_mode: "both",
    started_at: "2026-04-05T10:00:00.000Z",
    stopped_at: "2026-04-05T10:00:05.000Z",
    duration_seconds: 5,
    file_size_bytes: 160044,
    sample_rate: 16000,
    channels: 2,
    format: "wav",
    path: "/tmp/audio-mcp-fake.wav",
    is_active: false,
    ...overrides,
  };
}

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-mcp-store-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts and gets session metadata", () => {
    const meta = fixture();
    store.upsert(meta);
    expect(store.get(meta.session_id)).toEqual(meta);
  });

  it("list returns sessions newest first", () => {
    const older = fixture({
      session_id: "a",
      started_at: "2026-04-05T09:00:00.000Z",
    });
    const newer = fixture({
      session_id: "b",
      started_at: "2026-04-05T11:00:00.000Z",
    });
    store.upsert(older);
    store.upsert(newer);
    const listed = store.list();
    expect(listed.map((m) => m.session_id)).toEqual(["b", "a"]);
  });

  it("list skips malformed metadata files", () => {
    store.upsert(fixture({ session_id: "good" }));
    writeFileSync(join(dir, "bad.json"), "not-json", "utf8");
    expect(store.list().map((m) => m.session_id)).toEqual(["good"]);
  });

  it("delete removes metadata and WAV file", () => {
    const wavPath = join(dir, "track.wav");
    writeFileSync(wavPath, Buffer.alloc(44));
    store.upsert(fixture({ path: wavPath }));
    store.delete("00000000-0000-4000-8000-000000000001");
    expect(store.get("00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("delete throws SESSION_NOT_FOUND for unknown ids", () => {
    expect(() => store.delete("missing")).toThrow(AudioMcpError);
    try {
      store.delete("missing");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("SESSION_NOT_FOUND");
    }
  });

  it("delete throws SESSION_STILL_ACTIVE when session is active", () => {
    store.upsert(fixture({ is_active: true, stopped_at: null }));
    try {
      store.delete("00000000-0000-4000-8000-000000000001");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("SESSION_STILL_ACTIVE");
    }
  });
});

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { AudioMcpError } from "../errors.js";
import type { CaptureMode } from "../audio/capture.js";

export interface SessionMetadata {
  session_id: string;
  label: string;
  source: string;
  capture_mode: CaptureMode;
  started_at: string;
  stopped_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  sample_rate: number;
  channels: number;
  format: "wav";
  path: string;
  is_active: boolean;
}

/**
 * Persists session metadata as `<uuid>.json` alongside the WAV audio file in
 * the sessions directory. List order is newest-first by `started_at`.
 */
export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  private metaPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  upsert(meta: SessionMetadata): void {
    writeFileSync(this.metaPath(meta.session_id), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }

  get(sessionId: string): SessionMetadata | null {
    const path = this.metaPath(sessionId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
    } catch {
      return null;
    }
  }

  list(): SessionMetadata[] {
    if (!existsSync(this.sessionsDir)) return [];
    const entries = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    const out: SessionMetadata[] = [];
    for (const entry of entries) {
      try {
        const meta = JSON.parse(
          readFileSync(join(this.sessionsDir, entry), "utf8"),
        ) as SessionMetadata;
        out.push(meta);
      } catch {
        // Skip malformed metadata silently.
      }
    }
    out.sort((a, b) => (b.started_at < a.started_at ? -1 : b.started_at > a.started_at ? 1 : 0));
    return out;
  }

  /**
   * Delete a session's metadata and audio file. Refuses to delete an active
   * session; throws `SESSION_NOT_FOUND` if the session does not exist.
   */
  delete(sessionId: string): void {
    const meta = this.get(sessionId);
    if (!meta) {
      throw new AudioMcpError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }
    if (meta.is_active) {
      throw new AudioMcpError(
        "SESSION_STILL_ACTIVE",
        `Session ${sessionId} is still active — stop it before deleting.`,
      );
    }
    if (existsSync(meta.path)) unlinkSync(meta.path);
    const metaFile = this.metaPath(sessionId);
    if (existsSync(metaFile)) unlinkSync(metaFile);
  }

  /** Read current file size from disk if the WAV exists. */
  currentFileSize(meta: SessionMetadata): number | null {
    if (!existsSync(meta.path)) return null;
    return statSync(meta.path).size;
  }
}

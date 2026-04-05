import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { statSync, existsSync } from "node:fs";
import { WavWriter } from "../audio/wav.js";
import type { CaptureDevice, CaptureMode } from "../audio/capture.js";
import { AudioMcpError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SessionMetadata, SessionStore } from "./store.js";

export interface StartSessionInput {
  label?: string;
  source?: string;
  capture?: CaptureMode;
}

export interface StartSessionResult {
  session_id: string;
  label: string;
  source: string;
  capture_mode: CaptureMode;
  started_at: string;
  sample_rate: number;
  channels: number;
  format: "wav";
}

export interface StopSessionResult {
  session_id: string;
  label: string;
  started_at: string;
  stopped_at: string;
  duration_seconds: number;
  file_size_bytes: number;
  path: string;
}

export interface SessionManagerConfig {
  sampleRate: number;
  sessionsDir: string;
  defaultSource: string | null;
  defaultCaptureMode: CaptureMode;
}

export type DeviceResolver = (source?: string | null) => Promise<{
  deviceId: string | undefined;
  deviceName: string;
}>;

export type CaptureFactory = () => CaptureDevice;

interface ActiveSession {
  meta: SessionMetadata;
  capture: CaptureDevice;
  writer: WavWriter;
}

const CHANNELS_BY_MODE: Record<CaptureMode, number> = {
  mic: 1,
  system: 1,
  both: 2,
};

/**
 * Owns the single-active-session invariant. Coordinates a CaptureDevice
 * with a WavWriter and the SessionStore. Per-session `capture` mode
 * determines the channel layout (1 for mic/system, 2 for both → L=mic R=system).
 */
export class SessionManager {
  private active: ActiveSession | null = null;

  constructor(
    private readonly cfg: SessionManagerConfig,
    private readonly store: SessionStore,
    private readonly captureFactory: CaptureFactory,
    private readonly resolveDevice: DeviceResolver,
    private readonly logger: Logger,
  ) {}

  get hasActiveSession(): boolean {
    return this.active !== null;
  }

  get activeSessionId(): string | null {
    return this.active?.meta.session_id ?? null;
  }

  async start(input: StartSessionInput): Promise<StartSessionResult> {
    if (this.active) {
      throw new AudioMcpError(
        "SESSION_ALREADY_ACTIVE",
        `A session is already active (${this.active.meta.session_id}). Stop it before starting a new one.`,
      );
    }

    const captureMode: CaptureMode = input.capture ?? this.cfg.defaultCaptureMode;
    const channels = CHANNELS_BY_MODE[captureMode];
    const sourceInput = input.source ?? this.cfg.defaultSource ?? null;

    // Mic device is only relevant if we're actually capturing mic.
    let micDeviceId: string | undefined = undefined;
    let deviceLabel: string;
    if (captureMode === "system") {
      deviceLabel = "system audio";
    } else {
      try {
        const resolved = await this.resolveDevice(sourceInput);
        micDeviceId = resolved.deviceId;
        deviceLabel = resolved.deviceName;
      } catch (err) {
        if (err instanceof AudioMcpError) throw err;
        throw new AudioMcpError("AUDIO_DEVICE_ERROR", (err as Error).message);
      }
      if (captureMode === "both") deviceLabel = `${deviceLabel} + system audio`;
    }

    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const label = input.label?.trim() || `session-${startedAt}`;
    const wavPath = join(this.cfg.sessionsDir, `${sessionId}.wav`);

    const capture = this.captureFactory();
    const writer = new WavWriter(wavPath, {
      sampleRate: this.cfg.sampleRate,
      channels,
    });

    // Forward PCM chunks straight to the WAV writer. Append errors are logged
    // but do not abort the session.
    capture.onData((chunk) => {
      writer.append(chunk).catch((err) => {
        this.logger.error("wav append failed", { error: (err as Error).message });
      });
    });

    try {
      await capture.start({
        sampleRate: this.cfg.sampleRate,
        channels,
        captureMode,
        micDeviceId,
        excludePid: process.ppid,
      });
    } catch (err) {
      try {
        await writer.finalize();
      } catch {
        /* ignore */
      }
      if (err instanceof AudioMcpError) throw err;
      throw new AudioMcpError("AUDIO_DEVICE_ERROR", (err as Error).message);
    }

    const meta: SessionMetadata = {
      session_id: sessionId,
      label,
      source: deviceLabel,
      capture_mode: captureMode,
      started_at: startedAt,
      stopped_at: null,
      duration_seconds: null,
      file_size_bytes: null,
      sample_rate: this.cfg.sampleRate,
      channels,
      format: "wav",
      path: wavPath,
      is_active: true,
    };
    this.store.upsert(meta);

    this.active = { meta, capture, writer };
    this.logger.info("session started", {
      session_id: sessionId,
      capture_mode: captureMode,
      source: deviceLabel,
      label,
    });

    return {
      session_id: sessionId,
      label,
      source: deviceLabel,
      capture_mode: captureMode,
      started_at: startedAt,
      sample_rate: this.cfg.sampleRate,
      channels,
      format: "wav",
    };
  }

  async stop(sessionId: string): Promise<StopSessionResult> {
    if (!this.active || this.active.meta.session_id !== sessionId) {
      const existing = this.store.get(sessionId);
      if (!existing) {
        throw new AudioMcpError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      }
      if (!existing.is_active) {
        throw new AudioMcpError(
          "SESSION_NOT_FOUND",
          `Session ${sessionId} is not currently active.`,
        );
      }
      throw new AudioMcpError("SESSION_NOT_FOUND", `Session ${sessionId} not active in-process.`);
    }

    const { meta, capture, writer } = this.active;

    await capture.stop();
    const { bytesWritten, durationSeconds } = await writer.finalize();
    const stoppedAt = new Date().toISOString();
    const fileSize = existsSync(meta.path) ? statSync(meta.path).size : bytesWritten + 44;

    const updated: SessionMetadata = {
      ...meta,
      stopped_at: stoppedAt,
      duration_seconds: durationSeconds,
      file_size_bytes: fileSize,
      is_active: false,
    };
    this.store.upsert(updated);
    this.active = null;
    this.logger.info("session stopped", {
      session_id: sessionId,
      duration_seconds: durationSeconds,
    });

    return {
      session_id: sessionId,
      label: updated.label,
      started_at: updated.started_at,
      stopped_at: stoppedAt,
      duration_seconds: durationSeconds,
      file_size_bytes: fileSize,
      path: updated.path,
    };
  }

  /** Stop the active session on shutdown, swallowing any errors. */
  async gracefulStop(): Promise<void> {
    if (!this.active) return;
    try {
      await this.stop(this.active.meta.session_id);
    } catch (err) {
      this.logger.error("graceful stop failed", { error: (err as Error).message });
    }
  }
}

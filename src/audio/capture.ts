export type CaptureMode = "mic" | "system" | "both";

export interface CaptureOptions {
  sampleRate: number;
  /** 1 for mic/system, 2 for both. Must agree with captureMode. */
  channels: number;
  captureMode: CaptureMode;
  /** Optional AVCaptureDevice uniqueID; undefined → system default input. */
  micDeviceId?: string;
  /** PID of the parent MCP client to exclude from system audio capture. */
  excludePid?: number;
}

export interface DeviceSummary {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rates: number[];
}

/**
 * Produces raw PCM frames (Int16 little-endian, possibly interleaved
 * stereo) to a consumer callback. One implementation (`HelperProcessCapture`)
 * spawns the bundled Swift helper binary; tests swap in `MockCapture`.
 */
export interface CaptureDevice {
  start(opts: CaptureOptions): Promise<void>;
  onData(cb: (chunk: Buffer) => void): void;
  stop(): Promise<void>;
}

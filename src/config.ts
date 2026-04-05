import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Paths } from "./paths.js";

import type { CaptureMode } from "./audio/capture.js";

export interface AudioMcpConfig {
  default_source: string | null;
  default_capture_mode: CaptureMode;
  sample_rate: number;
  sessions_dir: string | null;
}

export const DEFAULT_CONFIG: AudioMcpConfig = {
  default_source: null,
  default_capture_mode: "both",
  sample_rate: 16000,
  sessions_dir: null,
};

/**
 * Load config from disk, creating the file with defaults if missing.
 * Unknown keys are preserved on rewrite. Missing keys fall back to defaults.
 */
export function loadOrCreateConfig(paths: Paths): AudioMcpConfig {
  if (!existsSync(paths.configFile)) {
    writeFileSync(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<AudioMcpConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Malformed config — fall back to defaults without overwriting user's file.
    return { ...DEFAULT_CONFIG };
  }
}

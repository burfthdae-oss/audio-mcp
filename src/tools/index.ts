import { z } from "zod";
import type { SessionManager } from "../session/manager.js";
import type { SessionStore, SessionMetadata } from "../session/store.js";
import { AudioMcpError } from "../errors.js";
import { statSync, existsSync } from "node:fs";
import { sliceWav } from "../audio/wav.js";
import type { DeviceSummary, CaptureMode } from "../audio/capture.js";

const WAV_HEADER_SIZE = 44;

const MAX_CHUNK_SECONDS = 300;

export interface ToolsContext {
  manager: SessionManager;
  store: SessionStore;
  listInputDevices: () => Promise<DeviceSummary[]>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<any>;
}

function toSessionListItem(meta: SessionMetadata): {
  session_id: string;
  label: string;
  capture_mode: CaptureMode;
  started_at: string;
  stopped_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  channels: number;
  is_active: boolean;
} {
  // For active sessions, report a live snapshot of disk size + duration
  // so agents can poll progress without stopping the session.
  let fileSize = meta.file_size_bytes;
  let durationSeconds = meta.duration_seconds;
  if (meta.is_active && existsSync(meta.path)) {
    fileSize = statSync(meta.path).size;
    const dataBytes = Math.max(0, fileSize - WAV_HEADER_SIZE);
    const bytesPerSec = meta.sample_rate * meta.channels * 2;
    durationSeconds = bytesPerSec > 0 ? dataBytes / bytesPerSec : 0;
  }
  return {
    session_id: meta.session_id,
    label: meta.label,
    capture_mode: meta.capture_mode,
    started_at: meta.started_at,
    stopped_at: meta.stopped_at,
    duration_seconds: durationSeconds,
    file_size_bytes: fileSize,
    channels: meta.channels,
    is_active: meta.is_active,
  };
}

export function buildTools(ctx: ToolsContext): ToolDefinition[] {
  const startSession: ToolDefinition = {
    name: "start_session",
    description:
      "Start a new audio capture session. Captures mic, system output, or both into a single WAV. " +
      "For capture='both' the file is stereo with L=mic and R=system audio. " +
      "Fails with SESSION_ALREADY_ACTIVE if a session is already running.",
    inputSchema: {
      label: z.string().optional().describe("Human-readable name for the session."),
      source: z
        .string()
        .optional()
        .describe(
          "Microphone device uniqueID or substring-matched name. Only used when capture includes 'mic'. Omit for system default.",
        ),
      capture: z
        .enum(["mic", "system", "both"])
        .optional()
        .describe(
          "What to capture. 'mic'=microphone only; 'system'=system audio output only (requires Screen Recording permission); 'both'=stereo WAV with L=mic R=system. Defaults to 'both'.",
        ),
    },
    handler: async (input: { label?: string; source?: string; capture?: CaptureMode }) => {
      return ctx.manager.start({
        label: input.label,
        source: input.source,
        capture: input.capture,
      });
    },
  };

  const stopSession: ToolDefinition = {
    name: "stop_session",
    description: "Stop the active capture session and finalize the WAV file.",
    inputSchema: {
      session_id: z.string().describe("The UUID returned by start_session."),
    },
    handler: async (input: { session_id: string }) => {
      return ctx.manager.stop(input.session_id);
    },
  };

  const getAudio: ToolDefinition = {
    name: "get_audio",
    description:
      "Return a base64-encoded WAV slice of a recorded session. Max 300 seconds per call; " +
      "chunk larger ranges yourself.",
    inputSchema: {
      session_id: z.string(),
      start_second: z
        .number()
        .min(0)
        .optional()
        .describe("Start of the slice, in seconds (default 0)."),
      end_second: z
        .number()
        .min(0)
        .optional()
        .describe("End of the slice, in seconds (default: end of session)."),
      format: z
        .enum(["wav", "opus"])
        .optional()
        .describe("Output format. Only 'wav' is supported in v1."),
    },
    handler: async (input: {
      session_id: string;
      start_second?: number;
      end_second?: number;
      format?: "wav" | "opus";
    }) => {
      if (input.format && input.format === "opus") {
        throw new AudioMcpError(
          "NOT_IMPLEMENTED",
          "Opus output is planned for v2. Request format: 'wav' instead.",
        );
      }
      const meta = ctx.store.get(input.session_id);
      if (!meta) {
        throw new AudioMcpError(
          "SESSION_NOT_FOUND",
          `Session not found: ${input.session_id}`,
        );
      }
      // Active sessions are readable — we compute the live duration from
      // the WAV file's current size so agents can poll mid-recording.
      let sessionDuration: number;
      if (meta.is_active && existsSync(meta.path)) {
        const dataBytes = Math.max(0, statSync(meta.path).size - WAV_HEADER_SIZE);
        const bytesPerSec = meta.sample_rate * meta.channels * 2;
        sessionDuration = bytesPerSec > 0 ? dataBytes / bytesPerSec : 0;
      } else {
        sessionDuration = meta.duration_seconds ?? 0;
      }
      const startSec = input.start_second ?? 0;
      const endSec = input.end_second ?? sessionDuration;
      if (endSec <= startSec) {
        throw new AudioMcpError(
          "INVALID_INPUT",
          `end_second (${endSec}) must be greater than start_second (${startSec}).`,
        );
      }
      if (endSec - startSec > MAX_CHUNK_SECONDS) {
        throw new AudioMcpError(
          "CHUNK_TOO_LARGE",
          `Requested ${endSec - startSec}s exceeds the 300s chunk limit. ` +
            `Split into multiple calls, e.g. [${startSec}, ${startSec + MAX_CHUNK_SECONDS}] then ` +
            `[${startSec + MAX_CHUNK_SECONDS}, ${endSec}].`,
        );
      }
      const slice = sliceWav(meta.path, startSec, endSec);
      return {
        session_id: input.session_id,
        start_second: startSec,
        end_second: slice.endSecond,
        duration_seconds: slice.durationSeconds,
        format: "wav" as const,
        sample_rate: slice.sampleRate,
        channels: slice.channels,
        audio_base64: slice.audio.toString("base64"),
        size_bytes: slice.byteLength,
      };
    },
  };

  const listSessions: ToolDefinition = {
    name: "list_sessions",
    description: "List all recorded sessions, newest first.",
    inputSchema: {},
    handler: async () => {
      return { sessions: ctx.store.list().map(toSessionListItem) };
    },
  };

  const getSession: ToolDefinition = {
    name: "get_session",
    description: "Return metadata for a single session.",
    inputSchema: {
      session_id: z.string(),
    },
    handler: async (input: { session_id: string }) => {
      const meta = ctx.store.get(input.session_id);
      if (!meta) {
        throw new AudioMcpError(
          "SESSION_NOT_FOUND",
          `Session not found: ${input.session_id}`,
        );
      }
      return toSessionListItem(meta);
    },
  };

  const listAudioSources: ToolDefinition = {
    name: "list_audio_sources",
    description: "List available microphone input devices on this machine.",
    inputSchema: {},
    handler: async () => {
      return { sources: await ctx.listInputDevices() };
    },
  };

  const deleteSession: ToolDefinition = {
    name: "delete_session",
    description: "Permanently delete a session's audio file and metadata. Refuses active sessions.",
    inputSchema: {
      session_id: z.string(),
    },
    handler: async (input: { session_id: string }) => {
      ctx.store.delete(input.session_id);
      return { session_id: input.session_id, deleted: true };
    },
  };

  return [
    startSession,
    stopSession,
    getAudio,
    listSessions,
    getSession,
    listAudioSources,
    deleteSession,
  ];
}

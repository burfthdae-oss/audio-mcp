export const ErrorCode = {
  SESSION_ALREADY_ACTIVE: "SESSION_ALREADY_ACTIVE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_STILL_ACTIVE: "SESSION_STILL_ACTIVE",
  AUDIO_DEVICE_ERROR: "AUDIO_DEVICE_ERROR",
  CHUNK_TOO_LARGE: "CHUNK_TOO_LARGE",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  INVALID_INPUT: "INVALID_INPUT",
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

export class AudioMcpError extends Error {
  public readonly code: ErrorCodeName;

  constructor(code: ErrorCodeName, message: string) {
    super(message);
    this.name = "AudioMcpError";
    this.code = code;
  }

  toJSON(): { code: ErrorCodeName; message: string } {
    return { code: this.code, message: this.message };
  }
}

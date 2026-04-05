import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * File-backed logger. Writes JSON-per-line to `filePath`, rolling when the
 * file grows past 10 MB (rotates to `<filePath>.1`, overwriting any prior).
 * Writes are synchronous to guarantee ordering under SIGINT without leaking
 * into MCP's stdio stream.
 */
export function createFileLogger(filePath: string): Logger {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    try {
      if (existsSync(filePath) && statSync(filePath).size > MAX_LOG_BYTES) {
        renameSync(filePath, `${filePath}.1`);
      }
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...(meta ?? {}),
      });
      appendFileSync(filePath, entry + "\n", "utf8");
    } catch {
      // Never let logging failures propagate.
    }
  };
  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CaptureDevice, CaptureOptions } from "./capture.js";
import { HELPER_BIN, verifyHelper, HelperBinaryError } from "./helper-path.js";
import { AudioMcpError } from "../errors.js";

const GATEKEEPER_EXIT = 9; // process killed by Gatekeeper (SIGKILL)

/**
 * Spawns the bundled Swift audio-capture-helper as a child process and
 * forwards its stdout (raw PCM) to an `onData` callback.
 *
 * Lifecycle:
 *  1. `start()` verifies the binary exists, spawns it with the requested
 *     CLI flags, waits briefly to catch immediate permission/Gatekeeper
 *     failures, then returns.
 *  2. While running, each `stdout` chunk is forwarded verbatim. stderr
 *     JSON-lines are held in a buffer and surfaced on error.
 *  3. `stop()` sends SIGTERM and awaits the child's exit.
 */
export interface HelperProcessCaptureOptions {
  /**
   * Override the full `[executable, ...args]` prefix used to spawn the
   * helper. Tests inject something like `["node", "/path/to/stub-helper.js"]`.
   * Default: `[HELPER_BIN]` (the bundled Swift binary).
   */
  command?: string[];
}

export class HelperProcessCapture implements CaptureDevice {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private dataCb: ((chunk: Buffer) => void) | null = null;
  private stderrBuf = "";
  private exitPromise: Promise<number> | null = null;
  private readonly command: string[];

  constructor(opts: HelperProcessCaptureOptions = {}) {
    this.command = opts.command ?? [HELPER_BIN];
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }

  async start(opts: CaptureOptions): Promise<void> {
    // Only verify the packaged binary when using the default helper path.
    if (this.command.length === 1 && this.command[0] === HELPER_BIN) {
      const badBinary = verifyHelper();
      if (badBinary) throw this.binaryErrorToAudioMcpError(badBinary);
    }

    const args = [
      ...this.command.slice(1),
      "capture",
      `--mode=${opts.captureMode}`,
      `--sample-rate=${opts.sampleRate}`,
    ];
    if (opts.micDeviceId) args.push(`--mic-device-id=${opts.micDeviceId}`);
    if (opts.excludePid) args.push(`--exclude-pid=${opts.excludePid}`);

    const executable = this.command[0];
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.stderrBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.dataCb) this.dataCb(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
    });

    this.exitPromise = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        // Translate signal into exit code convention (128 + signo).
        if (code !== null) resolve(code);
        else if (signal === "SIGKILL") resolve(GATEKEEPER_EXIT);
        else resolve(-1);
      });
    });

    // Race start() against an early-exit to catch permission failures.
    const earlyFail = await this.waitForEarlyFail(300);
    if (earlyFail) {
      throw this.translateExit(earlyFail);
    }
  }

  private waitForEarlyFail(ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, ms);
      this.exitPromise!.then((code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code);
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    if (this.exitPromise) {
      await this.exitPromise;
    }
    this.child = null;
  }

  private binaryErrorToAudioMcpError(err: HelperBinaryError): AudioMcpError {
    if (err.reason === "missing") {
      return new AudioMcpError("AUDIO_DEVICE_ERROR", err.message);
    }
    if (err.reason === "not_executable") {
      return new AudioMcpError(
        "AUDIO_DEVICE_ERROR",
        `${err.message}\n\nIf macOS Gatekeeper blocked the binary, run:\n  xattr -d com.apple.quarantine "${HELPER_BIN}"\nOr approve it in System Settings → Privacy & Security.`,
      );
    }
    return new AudioMcpError("AUDIO_DEVICE_ERROR", err.message);
  }

  private translateExit(code: number): AudioMcpError {
    const stderrMsg = this.extractStderrMessage();
    switch (code) {
      case 2:
        return new AudioMcpError(
          "AUDIO_DEVICE_ERROR",
          `Microphone permission denied. ${stderrMsg}\n\n` +
            "Grant mic access in System Settings → Privacy & Security → Microphone for your MCP client, then restart the client.",
        );
      case 3:
        return new AudioMcpError(
          "AUDIO_DEVICE_ERROR",
          `Screen Recording permission denied (required for system audio capture). ${stderrMsg}\n\n` +
            "Grant access in System Settings → Privacy & Security → Screen Recording for your MCP client, then restart the client.",
        );
      case GATEKEEPER_EXIT:
        return new AudioMcpError(
          "AUDIO_DEVICE_ERROR",
          `macOS Gatekeeper blocked the audio helper binary. Run:\n` +
            `  xattr -d com.apple.quarantine "${HELPER_BIN}"\n` +
            `Or: System Settings → Privacy & Security → scroll to the blocked binary message → "Allow Anyway".`,
        );
      default:
        return new AudioMcpError(
          "AUDIO_DEVICE_ERROR",
          `audio-capture-helper exited with code ${code}. ${stderrMsg}`,
        );
    }
  }

  private extractStderrMessage(): string {
    const lines = this.stderrBuf.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { msg?: string; level?: string };
        if (parsed.level === "error" && parsed.msg) {
          return parsed.msg;
        }
      } catch {
        /* not JSON */
      }
    }
    return lines.length ? lines[lines.length - 1] : "";
  }
}

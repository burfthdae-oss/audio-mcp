import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperProcessCapture } from "../src/audio/helper-capture.js";
import { AudioMcpError } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "helpers", "stub-helper.js");

function makeCapture(extraEnv?: Record<string, string>): HelperProcessCapture {
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  }
  return new HelperProcessCapture({ command: ["node", STUB] });
}

function clearEnv(keys: string[]): void {
  for (const k of keys) delete process.env[k];
}

describe("HelperProcessCapture ↔ helper protocol", () => {
  it("forwards stdout PCM chunks to onData and stops on SIGTERM", async () => {
    const capture = makeCapture();
    const received: Buffer[] = [];
    capture.onData((chunk) => received.push(chunk));
    await capture.start({
      sampleRate: 16000,
      channels: 2,
      captureMode: "both",
    });
    await new Promise((r) => setTimeout(r, 50));
    await capture.stop();
    const total = Buffer.concat(received);
    // At 10ms ticks over ~50ms we expect ~5 ticks × 640 bytes = ~3200.
    // Don't assert exact count — timing is fuzzy — just non-empty and
    // aligned to frame boundaries (4 bytes per stereo frame).
    expect(total.length).toBeGreaterThan(0);
    expect(total.length % 4).toBe(0);
  });

  it("stop() is idempotent and safe if never started", async () => {
    const capture = makeCapture();
    await capture.stop();
    await capture.stop();
  });

  it("surfaces early-exit code 2 as mic permission AUDIO_DEVICE_ERROR", async () => {
    const capture = makeCapture({ STUB_EARLY_EXIT: "2" });
    try {
      await capture.start({ sampleRate: 16000, channels: 1, captureMode: "mic" });
      expect.fail("expected start to throw");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("AUDIO_DEVICE_ERROR");
      expect((e as Error).message).toContain("Microphone permission");
    } finally {
      clearEnv(["STUB_EARLY_EXIT"]);
    }
  });

  it("surfaces early-exit code 3 as screen recording permission error", async () => {
    const capture = makeCapture({ STUB_EARLY_EXIT: "3" });
    try {
      await capture.start({ sampleRate: 16000, channels: 1, captureMode: "system" });
      expect.fail("expected start to throw");
    } catch (e) {
      expect((e as AudioMcpError).code).toBe("AUDIO_DEVICE_ERROR");
      expect((e as Error).message).toContain("Screen Recording");
    } finally {
      clearEnv(["STUB_EARLY_EXIT"]);
    }
  });
});

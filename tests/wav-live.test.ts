import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WavWriter, sliceWav } from "../src/audio/wav.js";

describe("sliceWav on mid-recording (unfinalized) WAV", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-mcp-live-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads partial audio when the WAV header's dataSize is still 0", async () => {
    const path = join(dir, "active.wav");
    const writer = new WavWriter(path, { sampleRate: 16000, channels: 1 });
    // Write 1.5 seconds of audio without calling finalize().
    await writer.append(Buffer.alloc(32000, 0x11)); // 1 second
    await writer.append(Buffer.alloc(16000, 0x22)); // 0.5 seconds

    const slice = sliceWav(path, 0, 2);
    // Session has 1.5s of audio; slice should clamp to that.
    expect(slice.durationSeconds).toBeCloseTo(1.5, 3);
    expect(slice.endSecond).toBeCloseTo(1.5, 3);
    expect(slice.byteLength).toBe(44 + 48000);
    expect(slice.audio[44]).toBe(0x11);
    expect(slice.audio[44 + 40000]).toBe(0x22);

    // After finalize, slices still work the same way.
    await writer.finalize();
    const after = sliceWav(path, 0, 2);
    expect(after.durationSeconds).toBeCloseTo(1.5, 3);
  });

  it("returns empty slice when start_second is beyond current write position", async () => {
    const path = join(dir, "beyond.wav");
    const writer = new WavWriter(path, { sampleRate: 16000, channels: 1 });
    await writer.append(Buffer.alloc(32000, 0xaa)); // 1 second written
    const slice = sliceWav(path, 5, 10); // asking for 5-10s on a 1s file
    expect(slice.durationSeconds).toBe(0);
    expect(slice.byteLength).toBe(44);
  });
});

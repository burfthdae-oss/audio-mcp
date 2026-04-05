import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWavHeader, WavWriter, readWavFormat, sliceWav } from "../src/audio/wav.js";

describe("wav", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-mcp-wav-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildWavHeader writes correct fields for 16 kHz mono PCM", () => {
    const header = buildWavHeader({ sampleRate: 16000, channels: 1 }, 3200);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.readUInt32LE(4)).toBe(36 + 3200);
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.toString("ascii", 12, 16)).toBe("fmt ");
    expect(header.readUInt32LE(16)).toBe(16);
    expect(header.readUInt16LE(20)).toBe(1); // PCM
    expect(header.readUInt16LE(22)).toBe(1); // channels
    expect(header.readUInt32LE(24)).toBe(16000);
    expect(header.readUInt32LE(28)).toBe(32000); // byteRate
    expect(header.readUInt16LE(32)).toBe(2); // blockAlign
    expect(header.readUInt16LE(34)).toBe(16); // bits per sample
    expect(header.toString("ascii", 36, 40)).toBe("data");
    expect(header.readUInt32LE(40)).toBe(3200);
  });

  it("WavWriter appends PCM chunks and finalizes header sizes", async () => {
    const path = join(dir, "out.wav");
    const writer = new WavWriter(path, { sampleRate: 16000, channels: 1 });
    const chunk = Buffer.alloc(32000, 0); // 1 second of silence
    await writer.append(chunk);
    await writer.append(chunk);
    const { bytesWritten, durationSeconds } = await writer.finalize();
    expect(bytesWritten).toBe(64000);
    expect(durationSeconds).toBeCloseTo(2, 5);

    const file = readFileSync(path);
    expect(file.length).toBe(44 + 64000);
    expect(file.readUInt32LE(4)).toBe(36 + 64000);
    expect(file.readUInt32LE(40)).toBe(64000);

    const fmt = readWavFormat(path);
    expect(fmt).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataSize: 64000,
    });
  });

  it("sliceWav returns a self-contained WAV for the requested range", async () => {
    const path = join(dir, "slice.wav");
    const writer = new WavWriter(path, { sampleRate: 16000, channels: 1 });
    // Write 3 seconds with a distinct byte pattern per second.
    await writer.append(Buffer.alloc(32000, 0x11));
    await writer.append(Buffer.alloc(32000, 0x22));
    await writer.append(Buffer.alloc(32000, 0x33));
    await writer.finalize();

    const slice = sliceWav(path, 1, 2);
    expect(slice.sampleRate).toBe(16000);
    expect(slice.channels).toBe(1);
    expect(slice.durationSeconds).toBeCloseTo(1, 5);
    expect(slice.byteLength).toBe(44 + 32000);
    // PCM portion should be all 0x22 bytes.
    const pcm = slice.audio.subarray(44);
    expect(pcm.length).toBe(32000);
    expect(pcm[0]).toBe(0x22);
    expect(pcm[pcm.length - 1]).toBe(0x22);
  });

  it("sliceWav clamps endSecond to file duration", async () => {
    const path = join(dir, "clamp.wav");
    const writer = new WavWriter(path, { sampleRate: 16000, channels: 1 });
    await writer.append(Buffer.alloc(32000, 0xaa)); // 1 second
    await writer.finalize();

    const slice = sliceWav(path, 0, 60);
    expect(slice.durationSeconds).toBeCloseTo(1, 5);
    expect(slice.endSecond).toBeCloseTo(1, 5);
  });

  it("sliceWav rejects invalid ranges", () => {
    expect(() => sliceWav("/nonexistent.wav", -1, 1)).toThrow(/startSecond/);
  });
});

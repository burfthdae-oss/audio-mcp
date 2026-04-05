import type { CaptureDevice, CaptureOptions } from "../../src/audio/capture.js";

/**
 * Deterministic capture stand-in for tests. Emits synthetic PCM on demand
 * via `emitSeconds()`. For stereo ("both") sessions, emits an interleaved
 * pattern with distinct byte values for L and R so tests can verify channel
 * ordering. Never driven by a real clock.
 */
export class MockCapture implements CaptureDevice {
  private dataCb: ((chunk: Buffer) => void) | null = null;
  private opts: CaptureOptions | null = null;
  private stopped = false;

  async start(opts: CaptureOptions): Promise<void> {
    this.opts = opts;
    this.stopped = false;
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /**
   * Push `seconds` of synthetic PCM to the consumer. Mono sessions emit
   * `fillByte` bytes; stereo sessions emit alternating L/R bytes (L=`leftByte`,
   * R=`rightByte`) so tests can verify channel layout end-to-end.
   */
  emitSeconds(seconds: number, leftByte = 0, rightByte = 0): void {
    if (!this.opts || this.stopped || !this.dataCb) return;
    const frames = this.opts.sampleRate * seconds;
    const bytesPerFrame = this.opts.channels * 2;
    const totalBytes = frames * bytesPerFrame;
    const chunk = Buffer.alloc(totalBytes);
    if (this.opts.channels === 2) {
      for (let i = 0; i < frames; i++) {
        const off = i * 4;
        // 16-bit LE, low byte carries the marker we assert on.
        chunk[off] = leftByte;
        chunk[off + 1] = 0;
        chunk[off + 2] = rightByte;
        chunk[off + 3] = 0;
      }
    } else {
      chunk.fill(leftByte);
    }
    this.dataCb(chunk);
  }

  get captureMode(): string | undefined {
    return this.opts?.captureMode;
  }

  get channels(): number | undefined {
    return this.opts?.channels;
  }
}

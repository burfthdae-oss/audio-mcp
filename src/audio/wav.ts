import {
  createWriteStream,
  type WriteStream,
  promises as fsp,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";

const HEADER_SIZE = 44;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const PCM_FORMAT = 1;

export interface WavFormat {
  sampleRate: number;
  channels: number;
}

/** Build a 44-byte PCM WAV header. `dataSize` is the byte length of PCM data. */
export function buildWavHeader(
  { sampleRate, channels }: WavFormat,
  dataSize: number,
): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(PCM_FORMAT, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/**
 * Streaming WAV writer. Writes a zero-sized header up front, appends PCM
 * chunks as they arrive, then patches the header sizes on `finalize()`.
 * Audio data is never buffered entirely in memory.
 */
export class WavWriter {
  private stream: WriteStream;
  private bytesWritten = 0;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly format: WavFormat,
  ) {
    this.stream = createWriteStream(path);
    this.stream.write(buildWavHeader(format, 0));
  }

  /** Append a PCM chunk. Returns once the chunk is flushed to the OS. */
  append(chunk: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error("WavWriter already finalized"));
    return new Promise<void>((resolve, reject) => {
      this.stream.write(chunk, (err) => {
        if (err) reject(err);
        else {
          this.bytesWritten += chunk.length;
          resolve();
        }
      });
    });
  }

  /** Close the stream and rewrite the RIFF/data sizes in the header. */
  async finalize(): Promise<{ bytesWritten: number; durationSeconds: number }> {
    if (this.closed) {
      throw new Error("WavWriter already finalized");
    }
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    const fh = await fsp.open(this.path, "r+");
    try {
      const riffSize = Buffer.alloc(4);
      riffSize.writeUInt32LE(36 + this.bytesWritten, 0);
      await fh.write(riffSize, 0, 4, 4);
      const dataSize = Buffer.alloc(4);
      dataSize.writeUInt32LE(this.bytesWritten, 0);
      await fh.write(dataSize, 0, 4, 40);
    } finally {
      await fh.close();
    }

    const durationSeconds =
      this.bytesWritten / (this.format.sampleRate * this.format.channels * BYTES_PER_SAMPLE);
    return { bytesWritten: this.bytesWritten, durationSeconds };
  }

  get byteCount(): number {
    return this.bytesWritten;
  }
}

export interface WavSlice {
  audio: Buffer;
  startSecond: number;
  endSecond: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  byteLength: number;
}

/**
 * Read the PCM-format fields from a WAV file header. Throws if the file is
 * not a PCM WAV (format 1) with a well-formed RIFF/data structure.
 */
export function readWavFormat(path: string): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
} {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEADER_SIZE);
    readSync(fd, buf, 0, HEADER_SIZE, 0);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Not a RIFF/WAVE file");
    }
    const audioFormat = buf.readUInt16LE(20);
    if (audioFormat !== PCM_FORMAT) {
      throw new Error(`Unsupported WAV format: ${audioFormat} (only PCM is supported)`);
    }
    return {
      channels: buf.readUInt16LE(22),
      sampleRate: buf.readUInt32LE(24),
      bitsPerSample: buf.readUInt16LE(34),
      dataSize: buf.readUInt32LE(40),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read `[startSecond, endSecond)` from a PCM WAV and return a new
 * self-contained WAV buffer wrapping just the requested slice. Clamps
 * `endSecond` to the file's total duration.
 */
export function sliceWav(path: string, startSecond: number, endSecond: number): WavSlice {
  if (startSecond < 0) {
    throw new Error("startSecond must be >= 0");
  }
  if (endSecond <= startSecond) {
    throw new Error("endSecond must be > startSecond");
  }
  const fmt = readWavFormat(path);
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const fileSize = statSync(path).size;
  // During an active recording the header's dataSize is still 0 — the
  // WavWriter patches it only on finalize(). Fall back to the live file
  // size so callers can read partial audio mid-session.
  const availableDataBytes =
    fmt.dataSize > 0
      ? Math.min(fmt.dataSize, fileSize - HEADER_SIZE)
      : Math.max(0, fileSize - HEADER_SIZE);
  const totalSeconds = availableDataBytes / bytesPerSec;

  const clampedEnd = Math.min(endSecond, totalSeconds);
  if (clampedEnd <= startSecond) {
    // Range is entirely past end of file — return empty slice.
    return {
      audio: buildWavHeader({ sampleRate: fmt.sampleRate, channels: fmt.channels }, 0),
      startSecond,
      endSecond: startSecond,
      durationSeconds: 0,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      byteLength: HEADER_SIZE,
    };
  }

  // Align offsets to sample frame boundary.
  const frameSize = fmt.channels * (fmt.bitsPerSample / 8);
  const alignToFrame = (bytes: number): number => Math.floor(bytes / frameSize) * frameSize;
  const startByte = alignToFrame(Math.floor(startSecond * bytesPerSec));
  const endByte = alignToFrame(Math.floor(clampedEnd * bytesPerSec));
  const sliceBytes = endByte - startByte;

  const fd = openSync(path, "r");
  try {
    const pcm = Buffer.alloc(sliceBytes);
    readSync(fd, pcm, 0, sliceBytes, HEADER_SIZE + startByte);
    const header = buildWavHeader(
      { sampleRate: fmt.sampleRate, channels: fmt.channels },
      sliceBytes,
    );
    const audio = Buffer.concat([header, pcm]);
    return {
      audio,
      startSecond,
      endSecond: clampedEnd,
      durationSeconds: sliceBytes / bytesPerSec,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      byteLength: audio.length,
    };
  } finally {
    closeSync(fd);
  }
}

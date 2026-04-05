#!/usr/bin/env node
// Node stand-in for the Swift audio-capture-helper binary. Parses the same
// CLI shape, writes deterministic PCM bytes to stdout, and exits cleanly on
// SIGTERM. Used by tests/helper-protocol.test.ts to validate the
// HelperProcessCapture ↔ helper contract without needing a compiled Swift binary.

const args = process.argv.slice(2);
const subcommand = args[0];
if (subcommand !== "capture") {
  process.stderr.write(`stub-helper only supports 'capture'; got ${subcommand}\n`);
  process.exit(1);
}

let mode = "both";
let sampleRate = 16000;
// Check for special modes via env vars (tests set these).
// STUB_EARLY_EXIT=2 → exit with code 2 before writing
// STUB_BYTES_PER_TICK=N → override per-tick byte count
for (const arg of args.slice(1)) {
  if (arg.startsWith("--mode=")) mode = arg.slice("--mode=".length);
  else if (arg.startsWith("--sample-rate=")) sampleRate = Number(arg.slice("--sample-rate=".length));
}

if (process.env.STUB_EARLY_EXIT) {
  const code = Number(process.env.STUB_EARLY_EXIT);
  process.stderr.write(
    JSON.stringify({ level: "error", msg: `stub early exit code=${code}` }) + "\n",
  );
  process.exit(code);
}

const channels = mode === "both" ? 2 : 1;
const bytesPerSec = sampleRate * channels * 2;
// Emit at 10ms cadence (~1/100th of a second of data per tick).
const bytesPerTick = Number(process.env.STUB_BYTES_PER_TICK) || Math.floor(bytesPerSec / 100);

let tickCount = 0;
const interval = setInterval(() => {
  const buf = Buffer.alloc(bytesPerTick, tickCount & 0xff);
  process.stdout.write(buf);
  tickCount += 1;
}, 10);

function shutdown() {
  clearInterval(interval);
  process.stderr.write(JSON.stringify({ level: "info", msg: "stub shutting down" }) + "\n");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

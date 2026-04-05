import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, accessSync, constants as fsConstants } from "node:fs";

/**
 * Absolute path to the bundled audio-capture-helper binary. Resolves based
 * on this module's compiled location: `dist/audio/helper-path.js` → `dist/bin/audio-capture-helper`.
 * During development (when running TypeScript source directly), it falls
 * back to `dist/bin/...` relative to the repo root.
 */
function resolveHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled: dist/audio/helper-path.js → ../bin/audio-capture-helper
  const compiled = join(here, "..", "bin", "audio-capture-helper");
  if (existsSync(compiled)) return compiled;
  // Dev fallback: <repo>/src/audio/helper-path.ts → <repo>/dist/bin/audio-capture-helper
  const dev = join(here, "..", "..", "dist", "bin", "audio-capture-helper");
  return dev;
}

export const HELPER_BIN = resolveHelperPath();

export class HelperBinaryError extends Error {
  constructor(
    message: string,
    public readonly reason: "missing" | "not_executable" | "gatekeeper" | "other",
  ) {
    super(message);
    this.name = "HelperBinaryError";
  }
}

/**
 * Verify the helper binary is present and executable. Returns a structured
 * error identifying which remediation the user should take.
 */
export function verifyHelper(): HelperBinaryError | null {
  if (!existsSync(HELPER_BIN)) {
    return new HelperBinaryError(
      `audio-capture-helper not found at ${HELPER_BIN}. ` +
        `Reinstall audio-mcp or run 'npm run build:helper' from source.`,
      "missing",
    );
  }
  try {
    accessSync(HELPER_BIN, fsConstants.X_OK);
  } catch {
    return new HelperBinaryError(
      `audio-capture-helper is not executable at ${HELPER_BIN}. ` +
        `Run 'chmod +x ${HELPER_BIN}' and try again.`,
      "not_executable",
    );
  }
  return null;
}

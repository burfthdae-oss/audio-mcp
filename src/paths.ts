import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface Paths {
  root: string;
  sessionsDir: string;
  configFile: string;
  logFile: string;
}

/** Expand a leading `~` in a path to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve audio-mcp storage paths. By default rooted at `~/.audio-mcp`.
 * A custom root can be supplied (used by tests to isolate storage in a tmp dir).
 */
export function resolvePaths(root?: string, sessionsDirOverride?: string): Paths {
  const rootDir = root ?? join(homedir(), ".audio-mcp");
  const sessionsDir = sessionsDirOverride
    ? expandHome(sessionsDirOverride)
    : join(rootDir, "sessions");
  return {
    root: rootDir,
    sessionsDir,
    configFile: join(rootDir, "config.json"),
    logFile: join(rootDir, "audio-mcp.log"),
  };
}

/** Ensure the root and sessions directories exist. Idempotent. */
export function ensureDirs(paths: Paths): void {
  if (!existsSync(paths.root)) {
    mkdirSync(paths.root, { recursive: true });
  }
  if (!existsSync(paths.sessionsDir)) {
    mkdirSync(paths.sessionsDir, { recursive: true });
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolvePaths, ensureDirs } from "./paths.js";
import { loadOrCreateConfig } from "./config.js";
import { createFileLogger } from "./logger.js";
import { SessionStore } from "./session/store.js";
import { SessionManager } from "./session/manager.js";
import { HelperProcessCapture } from "./audio/helper-capture.js";
import { listInputDevices, resolveMicDevice } from "./audio/devices.js";
import { buildTools } from "./tools/index.js";
import { AudioMcpError } from "./errors.js";

const PKG_VERSION = "0.1.0";

function toCallToolResult<T>(value: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toCallToolError(err: unknown): CallToolResult {
  if (err instanceof AudioMcpError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2),
        },
      ],
      structuredContent: { error: { code: err.code, message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: "INTERNAL_ERROR", message } }, null, 2),
      },
    ],
    structuredContent: { error: { code: "INTERNAL_ERROR", message } },
  };
}

export async function startServer(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);
  const cfg = loadOrCreateConfig(paths);
  // If the user overrode sessions_dir in config, re-resolve + ensure.
  const resolved = resolvePaths(undefined, cfg.sessions_dir ?? undefined);
  ensureDirs(resolved);
  const logger = createFileLogger(resolved.logFile);
  logger.info("audio-mcp starting", { version: PKG_VERSION });

  const store = new SessionStore(resolved.sessionsDir);
  const manager = new SessionManager(
    {
      sampleRate: cfg.sample_rate,
      sessionsDir: resolved.sessionsDir,
      defaultSource: cfg.default_source,
      defaultCaptureMode: cfg.default_capture_mode,
    },
    store,
    () => new HelperProcessCapture(),
    (src) => resolveMicDevice(src),
    logger,
  );

  const tools = buildTools({
    manager,
    store,
    listInputDevices,
  });

  const server = new McpServer({ name: "audio-mcp", version: PKG_VERSION });
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callback = async (args: any): Promise<CallToolResult> => {
      try {
        const result = await tool.handler(args ?? {});
        return toCallToolResult(result);
      } catch (err) {
        logger.error(`tool ${tool.name} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return toCallToolError(err);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      callback,
    );
  }

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    try {
      await manager.gracefulStop();
    } catch (err) {
      logger.error("shutdown error", { error: (err as Error).message });
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // MCP clients signal shutdown by closing the stdio pipe.
  process.stdin.on("end", () => void shutdown("stdin-closed"));
  process.stdin.on("close", () => void shutdown("stdin-closed"));

  await server.connect(transport);
  logger.info("audio-mcp listening on stdio");
}

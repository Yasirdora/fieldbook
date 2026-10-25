#!/usr/bin/env node
/**
 * Starts the Fieldbook MCP server on stdio. Runs on the Mac.
 * Sessions are stored in $FIELDBOOK_HOME (default ~/Library/Application Support/Fieldbook).
 */
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultHome } from "./config.ts";
import { createContext } from "./context.ts";
import { realExec } from "./exec.ts";
import { createServer } from "./mcp.ts";

const ctx = createContext({ exec: realExec, home: defaultHome(), macHome: os.homedir(), hostName: os.hostname() });
const server = createServer(ctx);

/** Sessions stay "recording" on disk; session_stop can close them from a later server. */
function shutDown(): void {
  for (const recorder of ctx.recorders.values()) recorder.detach();
  process.exit(0);
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
process.stdin.on("end", shutDown);

await server.connect(new StdioServerTransport());

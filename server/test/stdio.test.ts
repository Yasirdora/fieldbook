/**
 * The real entry point starts and answers over stdio (no device is touched).
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../src/mcp.ts";
import { tempDir } from "./helpers.ts";

test("node src/main.ts serves the tool list over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "src", "main.ts")],
    env: { ...process.env, FIELDBOOK_HOME: tempDir("stdio-home") } as Record<string, string>,
  });
  const client = new Client({ name: "fieldbook-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  } finally {
    await client.close();
  }
});

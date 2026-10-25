/**
 * The MCP layer: the tools are listed, each answer is a plain summary first and JSON second,
 * and a problem the caller can fix comes back as an error message, not a crash.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, TOOL_NAMES } from "../src/mcp.ts";
import { BUNDLE } from "./fakes/world.ts";
import { setup } from "./testContext.ts";

async function connect() {
  const { ctx, world, clock } = setup();
  const server = createServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "fieldbook-test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, ctx, world, clock };
}

type TextContent = { type: "text"; text: string };

test("every Fieldbook tool is listed with a description", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) assert.ok((tool.description ?? "").length > 20, tool.name);
});

test("an answer is a summary first, then JSON", async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: "devices", arguments: { bundleId: BUNDLE } });
  const content = result.content as TextContent[];
  assert.equal(content.length, 2);
  assert.match(content[0]?.text ?? "", /^2 phones, 2 simulators and this Mac\./);
  const data = JSON.parse(content[1]?.text ?? "");
  assert.equal(data.phones[0].reachable.label, "measured");
});

test("a problem the caller can fix is an error message", async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: "timeline", arguments: { session: "no-such-session" } });
  assert.equal(result.isError, true);
  assert.match((result.content as TextContent[])[0]?.text ?? "", /No session no-such-session/);
});

test("inputs are checked: a wrong target is refused before anything runs", async () => {
  const { client, world } = await connect();
  const result = await client.callTool({
    name: "session_start",
    arguments: { target: "watch", bundleId: BUNDLE, label: "x" },
  });
  assert.equal(result.isError, true);
  assert.equal(world.calls.length, 0);
});

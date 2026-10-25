/**
 * The MCP server: registers Fieldbook's tools. Each tool answers with two text blocks:
 * a plain summary first, then the data as JSON. A problem the caller can fix (unknown
 * session, refused command) comes back as an error message.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "./context.ts";
import { RefusedCommand } from "./runner.ts";
import { ToolError, type ToolAnswer } from "./tools/common.ts";
import { devicesTool } from "./tools/devices.ts";
import { doctorTool } from "./tools/doctor.ts";
import { sessionStart, sessionStop } from "./tools/session.ts";
import { timelineTool } from "./tools/timeline.ts";
import { TOOL_VERSION } from "./version.ts";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(answer: ToolAnswer<unknown>): TextResult {
  return {
    content: [
      { type: "text", text: answer.summary },
      { type: "text", text: JSON.stringify(answer.data, null, 2) },
    ],
  };
}

function failure(text: string): TextResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function run(work: () => Promise<ToolAnswer<unknown>>): Promise<TextResult> {
  try {
    return reply(await work());
  } catch (error) {
    if (error instanceof ToolError || error instanceof RefusedCommand) return failure(error.message);
    return failure(`Fieldbook hit an unexpected error: ${(error as Error).stack ?? String(error)}`);
  }
}

const target = z.enum(["phone", "simulator", "mac"]);
const bundleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, "a bundle id such as com.example.app");

export const TOOL_NAMES = ["devices", "doctor", "session_start", "session_stop", "timeline"] as const;

export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: "fieldbook", version: TOOL_VERSION });

  server.registerTool(
    "devices",
    {
      title: "Devices",
      description:
        "Lists paired phones, simulators and this Mac: reachable or not, locked or not, and — with bundleId — whether that app is installed with container access. Every value has an evidence label.",
      inputSchema: { bundleId: bundleId.optional() },
    },
    (input) => run(() => devicesTool(ctx, input)),
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description:
        "Checks what works on this Mac right now: devicectl and simctl, each phone's tunnel, real screenshots, container access and the Darwin notification round trip (needs bundleId of a running Debug build). Each item is measured or missing.",
      inputSchema: { bundleId: bundleId.optional(), target: target.optional(), device: z.string().optional() },
    },
    (input) => run(() => doctorTool(ctx, input)),
  );

  server.registerTool(
    "session_start",
    {
      title: "Start a recording session",
      description:
        "Starts recording a Debug build that runs FieldbookKit: records device, app version/build and hello.json, then copies the app's mailbox every few seconds. Relaunches the app only with relaunch: true (then its console is recorded). A locked phone gets 'Unlock the phone' and nothing starts. build and change are free text (for example a commit and a Code Director lock id).",
      inputSchema: {
        target,
        device: z.string().optional().describe("Device id, UDID or name. Optional when there is only one."),
        bundleId,
        label: z.string().min(1).max(80),
        build: z.string().max(200).optional(),
        change: z.string().max(200).optional(),
        relaunch: z.boolean().optional(),
        fullText: z.boolean().optional().describe("Relaunch with -FieldbookText full so view text is stored in full. Needs relaunch: true."),
        pullSeconds: z.number().int().min(1).max(600).optional(),
      },
    },
    (input) => run(() => sessionStart(ctx, input)),
  );

  server.registerTool(
    "session_stop",
    {
      title: "Stop a recording session",
      description: "Makes a last copy of the mailbox, picks up new crash logs of this app, and closes the session bundle.",
      inputSchema: { session: z.string().min(1) },
    },
    (input) => run(() => sessionStop(ctx, input)),
  );

  server.registerTool(
    "timeline",
    {
      title: "Timeline",
      description:
        "A short text timeline of a session, for example '00:12.4 mark 3 \"pin on the wrong page\" (screen captured, tree 412 nodes)'. around (a mark number or name) narrows it to ±seconds (default 10). kinds filters (launch, lifecycle, log, hang, memory, mark, note, snapshot, command, metrickit, problem, crash).",
      inputSchema: {
        session: z.string().min(1),
        around: z.string().optional(),
        seconds: z.number().min(0).max(3600).optional(),
        kinds: z.array(z.string()).optional(),
      },
    },
    (input) => run(() => timelineTool(ctx, input)),
  );

  return server;
}

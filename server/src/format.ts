/**
 * Format version 1 on the server side: types and readers for the files the kit writes
 * (docs/FORMAT.md), and the writer for commands. The Swift side is kit/Sources/FieldbookCore.
 */
import { createHash } from "node:crypto";

export const FORMAT_VERSION = 1;

/** Thrown when a file is not format version 1 or is not the expected shape. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

// ---------------------------------------------------------------------------
// Shared shapes

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RedactedText {
  length: number;
  sha256_8: string;
  text?: string;
}

/** First 8 hex characters of the SHA-256 of the UTF-8 bytes. */
export function sha256_8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/**
 * Whether `query` matches a piece of redacted text: same fingerprint, or — when the full
 * text was recorded — the text contains the query (ignoring case).
 */
export function matchesText(query: string, redacted: RedactedText | undefined | null): boolean {
  if (!redacted) return false;
  if (redacted.sha256_8 === sha256_8(query)) return true;
  return typeof redacted.text === "string" && redacted.text.toLowerCase().includes(query.toLowerCase());
}

// ---------------------------------------------------------------------------
// hello.json

export interface Hello {
  formatVersion: number;
  probeVersion: string;
  runId: string;
  bundleId: string;
  appName: string;
  executable: string;
  appVersion: string;
  appBuild: string;
  commit: string | null;
  deviceModel: string;
  platform: string;
  isSimulator: boolean;
  osVersion: string;
  pid: number;
  processStart: string;
  redaction: "hashed" | "full";
  hangThresholdMs: number;
  writtenAt: string;
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FormatError(`${what} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FormatError(`${what} is not a JSON object`);
  const object = value as Record<string, unknown>;
  checkVersion(object.formatVersion, what);
  return object;
}

function checkVersion(version: unknown, what: string): void {
  if (version === FORMAT_VERSION) return;
  if (typeof version === "number" && version > FORMAT_VERSION) {
    throw new FormatError(`${what} has format version ${version}; this server reads version ${FORMAT_VERSION}. Update the server.`);
  }
  throw new FormatError(`${what} has no valid formatVersion`);
}

function requireStrings(object: Record<string, unknown>, keys: string[], what: string): void {
  for (const key of keys) {
    if (typeof object[key] !== "string") throw new FormatError(`${what} has no ${key}`);
  }
}

export function parseHello(text: string): Hello {
  const object = parseObject(text, "hello.json");
  requireStrings(object, ["runId", "bundleId", "appVersion", "appBuild", "processStart"], "hello.json");
  return object as unknown as Hello;
}

// ---------------------------------------------------------------------------
// events.jsonl

interface Envelope {
  formatVersion: number;
  runId: string;
  seq: number;
  time: string;
}

export type MailboxEvent = Envelope &
  (
    | { kind: "launch"; launch: { ms: number } }
    | { kind: "lifecycle"; lifecycle: { state: "active" | "inactive" | "background" } }
    | {
        kind: "log";
        log: { level: string; subsystem: string; category: string; message: string; cut: boolean; logTime: string };
      }
    | { kind: "hang"; hang: { start: string; ms: number } }
    | { kind: "memory"; memory: { footprint: number; peak: number } }
    | {
        kind: "mark";
        mark: { id: string; number: number; name?: string | null; source: "shake" | "key" | "command"; snapshotId: string; commandId?: string | null };
      }
    | { kind: "note"; note: { markId: string; text: string } }
    | {
        kind: "snapshot";
        snapshot: { id: string; reason: "mark" | "command"; ms: number; nodes: number; axNodes: number; truncated: boolean };
      }
    | { kind: "command"; command: { id: string; name: string; via: "notification" | "poll" } }
    | { kind: "metrickit"; metrickit: { file: string; type: string } }
    | { kind: "problem"; problem: { where: string; message: string } }
  );

export type EventKind = MailboxEvent["kind"];

export const EVENT_KINDS: readonly EventKind[] = [
  "launch",
  "lifecycle",
  "log",
  "hang",
  "memory",
  "mark",
  "note",
  "snapshot",
  "command",
  "metrickit",
  "problem",
];

/** Lines that end with a line break. A last line without one may still be in the middle of being written. */
export function completeLines(text: string): string[] {
  const parts = text.split("\n");
  parts.pop();
  return parts.filter((line) => line.trim().length > 0);
}

function asEvent(value: unknown): MailboxEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (event.formatVersion !== FORMAT_VERSION) return undefined;
  if (typeof event.runId !== "string" || typeof event.seq !== "number" || typeof event.time !== "string") return undefined;
  const kind = event.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) return undefined;
  const payload = event[kind];
  if (typeof payload !== "object" || payload === null) return undefined;
  return value as MailboxEvent;
}

/** Reads events.jsonl text. Lines that are broken, of a newer format or of an unknown kind are counted, not thrown. */
export function parseEvents(text: string): { events: MailboxEvent[]; skipped: number } {
  const events: MailboxEvent[] = [];
  let skipped = 0;
  for (const line of completeLines(text)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const event = asEvent(value);
    if (event) events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

// ---------------------------------------------------------------------------
// outbox and snapshots

export interface OutboxItem {
  formatVersion: number;
  seq: number;
  runId: string;
  time: string;
  kind: "result" | "mark" | "metrickit";
  commandId?: string | null;
  commandName?: string | null;
  via?: "notification" | "poll" | null;
  ok: boolean;
  message?: string | null;
  snapshotId?: string | null;
  markId?: string | null;
  file?: string | null;
}

export function parseOutboxItem(text: string): OutboxItem {
  const object = parseObject(text, "outbox item");
  if (typeof object.seq !== "number" || typeof object.kind !== "string") throw new FormatError("outbox item has no seq or kind");
  return object as unknown as OutboxItem;
}

export interface SnapshotInfo {
  formatVersion: number;
  id: string;
  time: string;
  reason: "mark" | "command";
  markId?: string | null;
  commandId?: string | null;
  ms: number;
  parts: ("tree" | "ax" | "state" | "rendered")[];
  tree?: { nodes: number; truncated: boolean } | null;
  ax?: { nodes: number; truncated: boolean } | null;
  problems: string[];
}

export function parseSnapshotInfo(text: string): SnapshotInfo {
  const object = parseObject(text, "snapshot.json");
  requireStrings(object, ["id", "time"], "snapshot.json");
  return object as unknown as SnapshotInfo;
}

export interface AXInfo {
  id?: string | null;
  label?: RedactedText | null;
  value?: RedactedText | null;
  traits: string[];
}

export interface ViewNode {
  type: string;
  frame: Rect;
  window: number;
  hidden: boolean;
  alpha: number;
  interactive: boolean;
  ax?: AXInfo | null;
  text?: RedactedText | null;
  scroll?: { offset: { x: number; y: number }; content: { w: number; h: number } } | null;
  children: ViewNode[];
}

export interface AXNode {
  source: "uikit.view" | "uikit.element" | "appkit.children";
  type: string;
  frame: Rect;
  id?: string | null;
  label?: RedactedText | null;
  value?: RedactedText | null;
  traits: string[];
  children: AXNode[];
}

export interface WindowTree<Node> {
  index: number;
  number?: number | null;
  isKey: boolean;
  title?: RedactedText | null;
  frame: Rect;
  root: Node;
}

export interface Tree<Node> {
  formatVersion: number;
  limit: number;
  nodes: number;
  truncated: boolean;
  windows: WindowTree<Node>[];
}

export function parseTree<Node = ViewNode>(text: string): Tree<Node> {
  const object = parseObject(text, "tree");
  if (!Array.isArray(object.windows)) throw new FormatError("tree has no windows");
  return object as unknown as Tree<Node>;
}

// ---------------------------------------------------------------------------
// Commands (written by the server)

export type CommandName = "mark" | "snapshot" | "ping" | "ack";

export interface CommandArgs {
  name?: string;
  ask?: boolean;
  parts?: ("tree" | "ax" | "state" | "rendered")[];
  upTo?: number;
}

export interface Command {
  formatVersion: number;
  id: string;
  seq: number;
  name: CommandName;
  sentAt: string;
  args: CommandArgs;
}

/** JSON text of one command file, keys sorted like the kit writes them. */
export function buildCommand(input: { id: string; seq: number; name: CommandName; sentAt: Date; args?: CommandArgs }): string {
  const command: Command = {
    args: input.args ?? {},
    formatVersion: FORMAT_VERSION,
    id: input.id,
    name: input.name,
    sentAt: input.sentAt.toISOString(),
    seq: input.seq,
  };
  return `${stableJson(command)}\n`;
}

export function parseCommand(text: string): Command {
  const object = parseObject(text, "command");
  requireStrings(object, ["id", "name", "sentAt"], "command");
  return object as unknown as Command;
}

/** File name of a command in the inbox: 000007-mark.json */
export function commandFileName(seq: number, name: CommandName): string {
  return `${String(seq).padStart(6, "0")}-${name}.json`;
}

/** JSON with sorted keys and 2-space indentation, ending without a newline. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sortKeys(object[key])]),
  );
}

/** Darwin notification names. */
export function notificationName(bundleId: string, box: "inbox" | "outbox"): string {
  return `fieldbook.${bundleId}.${box}`;
}

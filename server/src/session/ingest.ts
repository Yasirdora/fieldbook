/**
 * Ingest: turns the copied mailbox into the session bundle. New events go to
 * timeline.jsonl; marks get their own folder; snapshots and MetricKit files are copied.
 * Ingest remembers what it has seen (raw/ingest.json), so pulling twice files nothing twice.
 *
 * Everything in the mailbox copy is untrusted: names from it are checked before they become
 * paths, only regular files are copied (no folders, no links), and one bad event or file is
 * recorded as a problem and skipped — the rest of the pull goes on.
 */
import fs from "node:fs";
import path from "node:path";
import { parseEvents, parseHello, parseOutboxItem, parseSnapshotInfo, type Hello, type MailboxEvent, type OutboxItem, type SnapshotInfo } from "../format.ts";
import { readJson, readTextIfExists, slugify, writeJsonAtomic } from "../fsx.ts";
import { captured, measured, missing, rendered, reported, type Labeled } from "../labels.ts";
import type { SessionFile, TimelineEntry } from "./store.ts";

/** Events may be up to this much older than the session start (the two clocks can differ a little). */
export const CLOCK_MARGIN_MS = 2_000;

/** How many pulls an outbox item may hold back the ack while its files are missing. */
export const ACK_PATIENCE = 5;

/** A name from the mailbox that may become one part of a path. */
export function isSafeName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(name) && !name.startsWith(".");
}

type Pending =
  | { kind: "markSnapshot"; snapshotId: string; markId: string }
  | { kind: "snapshot"; snapshotId: string }
  | { kind: "metrickit"; file: string };

/** How far ingest has read one run's events, and the sequence numbers it has not seen yet. */
interface RunProgress {
  runId: string;
  highest: number;
  /** Ranges [from, to] below `highest` that were skipped, for example across a file rotation. */
  gaps: [number, number][];
}

interface FiledMark {
  id: string;
  n: number;
  dir: string;
  commandId: string | null;
}

export interface IngestState {
  formatVersion: 2;
  runs: RunProgress[];
  marks: FiledMark[];
  nextMark: number;
  /** Files the events named but the copy did not have yet. Tried again on the next pull. */
  pending: Pending[];
  /** Notes whose mark was not filed yet. */
  pendingNotes: { markId: string; text: string }[];
  /** Snapshot ids and MetricKit files that are safely in the session (the ack waits for them). */
  copied: { snapshots: string[]; files: string[] };
  /** Outbox items ("runId:seq") holding back the ack, and for how many pulls. */
  ackWaits: { key: string; pulls: number }[];
  skippedLines: number;
}

export interface IngestResult {
  entries: TimelineEntry[];
  marksFiled: number[];
  /** Every outbox item up to this seq is safely filed, so the app may delete it. */
  ackUpTo: number;
  hello?: Hello;
  helloProblem?: string;
}

export type PartName = "tree" | "ax" | "state" | "screenRendered" | "screenCaptured" | "note";

/** mark.json: one mark and where each of its files came from. */
export interface MarkFile {
  formatVersion: 1;
  n: number;
  id: string;
  runId: string;
  name: string | null;
  source: string;
  at: string;
  ms: number;
  commandId: string | null;
  snapshotId: string;
  snapshot: { ms: number; nodes: number | null; axNodes: number | null; truncated: boolean } | null;
  parts: Record<PartName, Labeled<string>>;
}

const SNAPSHOT_PARTS: { part: Exclude<PartName, "screenCaptured" | "note">; file: string; label: (file: string) => Labeled<string> }[] = [
  { part: "tree", file: "tree.json", label: (file) => measured(file, "the view tree, walked inside the app") },
  { part: "ax", file: "ax.json", label: (file) => measured(file, "the accessibility tree, walked inside the app") },
  { part: "state", file: "state.json", label: (file) => reported(file, "the app's own state") },
  { part: "screenRendered", file: "screen-rendered.png", label: (file) => rendered(file, "drawn by the app (drawHierarchy / cacheDisplay)") },
];

export function newIngestState(): IngestState {
  return {
    formatVersion: 2,
    runs: [],
    marks: [],
    nextMark: 1,
    pending: [],
    pendingNotes: [],
    copied: { snapshots: [], files: [] },
    ackWaits: [],
    skippedLines: 0,
  };
}

function statePath(sessionDir: string): string {
  return path.join(sessionDir, "raw", "ingest.json");
}

export function loadIngestState(sessionDir: string): IngestState {
  const file = statePath(sessionDir);
  return fs.existsSync(file) ? readJson<IngestState>(file) : newIngestState();
}

export function saveIngestState(sessionDir: string, state: IngestState): void {
  writeJsonAtomic(statePath(sessionDir), state);
}

/** Where the mark tool leaves a real screenshot until its mark is filed. */
export function capturePath(sessionDir: string, commandId: string): string {
  return path.join(sessionDir, "raw", "captures", `${commandId}.png`);
}

export function findMarkByCommand(state: IngestState, commandId: string): FiledMark | undefined {
  return state.marks.find((mark) => mark.commandId === commandId);
}

export function ingest(root: string, sessionDir: string, session: SessionFile, state: IngestState, now: Date): IngestResult {
  return new IngestRun(root, sessionDir, session, state, now).run();
}

/** One ingest pass. */
class IngestRun {
  private readonly entries: TimelineEntry[] = [];
  private readonly marksFiled: number[] = [];
  private readonly startedMs: number;
  private readonly root: string;
  private readonly sessionDir: string;
  private readonly state: IngestState;
  private readonly now: Date;
  private readonly sessionId: string;

  constructor(root: string, sessionDir: string, session: SessionFile, state: IngestState, now: Date) {
    this.root = root;
    this.sessionDir = sessionDir;
    this.state = state;
    this.now = now;
    this.sessionId = session.id;
    this.startedMs = Date.parse(session.startedAt);
  }

  run(): IngestResult {
    const result: IngestResult = { entries: this.entries, marksFiled: this.marksFiled, ackUpTo: 0 };
    const helloText = readTextIfExists(path.join(this.root, "hello.json"));
    if (helloText !== undefined) {
      try {
        result.hello = parseHello(helloText);
      } catch (error) {
        result.helloProblem = (error as Error).message;
      }
    }
    for (const event of this.newEvents()) {
      try {
        this.handle(event);
      } catch (error) {
        this.problem(`event ${event.runId}:${event.seq} (${event.kind}) could not be filed: ${(error as Error).message}`);
      }
    }
    this.retryPending();
    result.ackUpTo = this.ackUpTo();
    return result;
  }

  /** A problem of the server itself, as a timeline entry. */
  private problem(message: string): void {
    const at = this.now.toISOString();
    this.entries.push({ at, ms: Date.parse(at) - this.startedMs, kind: "problem", label: "measured", problem: { where: "server ingest", message } });
  }

  // -- events ----------------------------------------------------------------

  private newEvents(): MailboxEvent[] {
    const fresh: MailboxEvent[] = [];
    for (const name of ["events.1.jsonl", "events.jsonl"]) {
      const text = readRegularFile(path.join(this.root, name));
      if (text === undefined) continue;
      const { events, skipped } = parseEvents(text);
      this.state.skippedLines += skipped;
      for (const event of events) {
        if (!this.isNew(event)) continue;
        if (Date.parse(event.time) >= this.startedMs - CLOCK_MARGIN_MS) fresh.push(event);
      }
    }
    return fresh;
  }

  /** True the first time an event is seen. Sequence numbers skipped on the way are kept as gaps. */
  private isNew(event: MailboxEvent): boolean {
    let run = this.state.runs.find((candidate) => candidate.runId === event.runId);
    if (!run) {
      run = { runId: event.runId, highest: 0, gaps: [] };
      this.state.runs.push(run);
    }
    const { seq } = event;
    if (seq > run.highest) {
      if (seq > run.highest + 1) run.gaps.push([run.highest + 1, seq - 1]);
      if (run.gaps.length > 50) run.gaps.splice(0, run.gaps.length - 50);
      run.highest = seq;
      return true;
    }
    const gapIndex = run.gaps.findIndex(([from, to]) => seq >= from && seq <= to);
    if (gapIndex === -1) return false;
    const [from, to] = run.gaps[gapIndex] as [number, number];
    const rest: [number, number][] = [];
    if (from < seq) rest.push([from, seq - 1]);
    if (seq < to) rest.push([seq + 1, to]);
    run.gaps.splice(gapIndex, 1, ...rest);
    return true;
  }

  private entry(event: MailboxEvent, at: string, label: TimelineEntry["label"], payload: unknown): TimelineEntry {
    return { at, ms: Date.parse(at) - this.startedMs, kind: event.kind, label, runId: event.runId, seq: event.seq, [event.kind]: payload };
  }

  private handle(event: MailboxEvent): void {
    switch (event.kind) {
      case "mark":
        this.fileMark(event);
        return;
      case "note":
        this.fileNote(event.note.markId, event.note.text, event);
        return;
      case "snapshot":
        if (event.snapshot.reason === "command") this.fileSnapshot(event);
        return;
      case "metrickit":
        this.state.pending.push({ kind: "metrickit", file: event.metrickit.file });
        this.entries.push(this.entry(event, event.time, "measured", event.metrickit));
        return;
      case "hang":
        this.entries.push(this.entry(event, event.hang.start, "measured", event.hang));
        return;
      case "log":
        this.entries.push(this.entry(event, event.log.logTime, "measured", event.log));
        return;
      default:
        this.entries.push(this.entry(event, event.time, "measured", (event as unknown as Record<string, unknown>)[event.kind]));
    }
  }

  // -- marks ---------------------------------------------------------------

  private fileMark(event: Extract<MailboxEvent, { kind: "mark" }>): void {
    const mark = event.mark;
    if (this.state.marks.some((filed) => filed.id === mark.id)) return;
    const n = this.state.nextMark++;
    const dir = `marks/${n}-${slugify(mark.name ?? mark.source)}`;
    const commandId = this.isOwnCommand(mark.commandId) ? mark.commandId : null;
    this.state.marks.push({ id: mark.id, n, dir, commandId });
    const absolute = path.join(this.sessionDir, dir);
    fs.mkdirSync(absolute, { recursive: true });
    const markFile: MarkFile = {
      formatVersion: 1,
      n,
      id: mark.id,
      runId: event.runId,
      name: mark.name ?? null,
      source: mark.source,
      at: event.time,
      ms: Date.parse(event.time) - this.startedMs,
      commandId,
      snapshotId: mark.snapshotId,
      snapshot: null,
      parts: {
        tree: missing("the snapshot was not copied yet"),
        ax: missing("the snapshot was not copied yet"),
        state: missing("the snapshot was not copied yet"),
        screenRendered: missing("the snapshot was not copied yet"),
        screenCaptured: commandId
          ? missing("the Mac has not filed a capture for this mark yet")
          : missing("marked on the device; the Mac took no capture at that moment"),
        note: missing("the tester wrote no note"),
      },
    };
    if (!this.copyMarkSnapshot(absolute, markFile)) {
      this.state.pending.push({ kind: "markSnapshot", snapshotId: mark.snapshotId, markId: mark.id });
    }
    if (commandId) attachCaptureFile(this.sessionDir, absolute, markFile);
    writeMarkFile(absolute, markFile);
    for (const note of this.state.pendingNotes.filter((pending) => pending.markId === mark.id)) addNote(absolute, note.text);
    this.state.pendingNotes = this.state.pendingNotes.filter((pending) => pending.markId !== mark.id);
    this.marksFiled.push(n);
    this.entries.push(this.entry(event, event.time, "measured", { n, id: mark.id, name: mark.name ?? null, source: mark.source, dir, commandId }));
  }

  /** True for an id this session's commands use: "<session id>-<seq>". */
  private isOwnCommand(commandId: string | null | undefined): commandId is string {
    return typeof commandId === "string" && commandId.startsWith(`${this.sessionId}-`) && /^\d+$/.test(commandId.slice(this.sessionId.length + 1));
  }

  /** Copies the snapshot files into the mark folder. False when the snapshot is not in the copy yet. */
  private copyMarkSnapshot(markDir: string, markFile: MarkFile): boolean {
    const copied = this.copySnapshot(markFile.snapshotId, markDir);
    if (!copied) return false;
    for (const part of SNAPSHOT_PARTS) {
      markFile.parts[part.part] = copied.files.includes(part.file) ? part.label(part.file) : missing("not in this snapshot");
    }
    markFile.snapshot = {
      ms: copied.info.ms,
      nodes: copied.info.tree?.nodes ?? null,
      axNodes: copied.info.ax?.nodes ?? null,
      truncated: Boolean(copied.info.tree?.truncated || copied.info.ax?.truncated),
    };
    return true;
  }

  private fileNote(markId: string, text: string, event: MailboxEvent): void {
    const mark = this.state.marks.find((filed) => filed.id === markId);
    if (mark) addNote(path.join(this.sessionDir, mark.dir), text);
    else this.state.pendingNotes.push({ markId, text });
    this.entries.push(this.entry(event, event.time, "reported", { n: mark?.n ?? null, markId, text }));
  }

  // -- on-demand snapshots and MetricKit -------------------------------------

  private fileSnapshot(event: Extract<MailboxEvent, { kind: "snapshot" }>): void {
    const id = event.snapshot.id;
    if (!isSafeName(id)) {
      this.problem(`a snapshot id from the app is not a safe name and was skipped`);
      return;
    }
    this.state.pending.push({ kind: "snapshot", snapshotId: id });
    this.entries.push(this.entry(event, event.time, "measured", { ...event.snapshot, dir: `snapshots/${id}` }));
  }

  private retryPending(): void {
    this.state.pending = this.state.pending.filter((pending) => {
      try {
        return !this.tryPending(pending);
      } catch (error) {
        this.problem(`a ${pending.kind} copy failed and was dropped: ${(error as Error).message}`);
        return false;
      }
    });
  }

  /** True when the pending copy is done (or can never be done). */
  private tryPending(pending: Pending): boolean {
    switch (pending.kind) {
      case "markSnapshot": {
        const mark = this.state.marks.find((filed) => filed.id === pending.markId);
        if (!mark) return true;
        const absolute = path.join(this.sessionDir, mark.dir);
        const markFile = readMarkFile(absolute);
        if (!this.copyMarkSnapshot(absolute, markFile)) return false;
        writeMarkFile(absolute, markFile);
        return true;
      }
      case "snapshot":
        return this.copySnapshot(pending.snapshotId, path.join(this.sessionDir, "snapshots", pending.snapshotId)) !== undefined;
      case "metrickit":
        return this.copyMetricKit(pending.file);
    }
  }

  /** Copies snapshots/<id>/ from the mailbox copy (regular files only). Undefined when it is not there (yet). */
  private copySnapshot(snapshotId: string, destination: string): { files: string[]; info: SnapshotInfo } | undefined {
    if (!isSafeName(snapshotId)) return undefined;
    const source = path.join(this.root, "snapshots", snapshotId);
    if (!isRealFolder(source)) return undefined;
    const infoText = readRegularFile(path.join(source, "snapshot.json"));
    if (infoText === undefined) return undefined;
    let info: SnapshotInfo;
    try {
      info = parseSnapshotInfo(infoText);
    } catch {
      return undefined;
    }
    fs.mkdirSync(destination, { recursive: true });
    const files = fs.readdirSync(source).filter((name) => isSafeName(name) && isRegularFile(path.join(source, name)));
    for (const file of files) fs.copyFileSync(path.join(source, file), path.join(destination, file));
    if (!this.state.copied.snapshots.includes(snapshotId)) this.state.copied.snapshots.push(snapshotId);
    return { files: files.filter((file) => file !== "snapshot.json"), info };
  }

  /** True when the file is copied, or when it can never be (an unsafe name). */
  private copyMetricKit(relative: string): boolean {
    const parts = relative.split("/");
    if (parts.length !== 2 || parts[0] !== "metrickit" || !isSafeName(parts[1])) return true;
    const source = path.join(this.root, relative);
    if (!isRegularFile(source)) return false;
    const destinationDir = path.join(this.sessionDir, "metrickit");
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.copyFileSync(source, path.join(destinationDir, parts[1] as string));
    if (!this.state.copied.files.includes(relative)) this.state.copied.files.push(relative);
    return true;
  }

  // -- the ack -----------------------------------------------------------------

  /**
   * The highest outbox seq the app may delete: every item up to it is older than the session,
   * or its snapshot and file are safely in the session. An item whose files never arrive holds
   * the ack back for at most ACK_PATIENCE pulls, then it is let go with a problem entry.
   */
  private ackUpTo(): number {
    let upTo = 0;
    for (const item of readOutbox(this.root)) {
      if (!this.ackable(item)) break;
      upTo = item.seq;
    }
    return upTo;
  }

  private ackable(item: OutboxItem): boolean {
    if (Date.parse(item.time) < this.startedMs - CLOCK_MARGIN_MS) return true;
    const snapshotMissing = isSafeName(item.snapshotId) && !this.state.copied.snapshots.includes(item.snapshotId);
    const fileMissing = typeof item.file === "string" && !this.state.copied.files.includes(item.file);
    if (!snapshotMissing && !fileMissing) return true;
    const key = `${item.runId}:${item.seq}`;
    let wait = this.state.ackWaits.find((candidate) => candidate.key === key);
    if (!wait) {
      wait = { key, pulls: 0 };
      this.state.ackWaits.push(wait);
    }
    wait.pulls++;
    if (wait.pulls <= ACK_PATIENCE) return false;
    this.problem(`outbox item ${item.seq} names files that never arrived (${item.snapshotId ?? item.file}); the app may now delete it`);
    this.state.ackWaits = this.state.ackWaits.filter((candidate) => candidate.key !== key);
    return true;
  }
}

const OUTBOX_NAME = /^(\d{6,})-(result|mark|metrickit)\.json$/;

/** The outbox items of the copy whose file name and seq agree, oldest first. */
function readOutbox(root: string): OutboxItem[] {
  const outbox = path.join(root, "outbox");
  if (!isRealFolder(outbox)) return [];
  const items: OutboxItem[] = [];
  for (const name of fs.readdirSync(outbox)) {
    const match = OUTBOX_NAME.exec(name);
    if (!match) continue;
    const text = readRegularFile(path.join(outbox, name));
    if (text === undefined) continue;
    try {
      const item = parseOutboxItem(text);
      if (item.seq === Number(match[1])) items.push(item);
    } catch {
      // Not an outbox item this server can read; it is skipped (and not acknowledged past).
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isRealFolder(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The text of a regular file (not a link or folder), or undefined. */
function readRegularFile(file: string): string | undefined {
  return isRegularFile(file) ? readTextIfExists(file) : undefined;
}

export function readMarkFile(markDir: string): MarkFile {
  return readJson<MarkFile>(path.join(markDir, "mark.json"));
}

export function writeMarkFile(markDir: string, markFile: MarkFile): void {
  writeJsonAtomic(path.join(markDir, "mark.json"), markFile);
}

function addNote(markDir: string, text: string): void {
  fs.appendFileSync(path.join(markDir, "note.txt"), `${text}\n`);
  if (!fs.existsSync(path.join(markDir, "mark.json"))) return;
  const markFile = readMarkFile(markDir);
  markFile.parts.note = reported("note.txt", "the tester's words");
  writeMarkFile(markDir, markFile);
}

/** Copies the Mac's real screenshot for this mark's command into the mark folder, if there is one. */
function attachCaptureFile(sessionDir: string, markDir: string, markFile: MarkFile): boolean {
  if (!isSafeName(markFile.commandId)) return false;
  const file = capturePath(sessionDir, markFile.commandId);
  if (!isRegularFile(file)) return false;
  fs.copyFileSync(file, path.join(markDir, "screen-captured.png"));
  markFile.parts.screenCaptured = captured("screen-captured.png", captureSource(`${file.slice(0, -4)}.json`));
  return true;
}

/** The capture's source from the small JSON file the mark tool writes next to it. */
function captureSource(metaFile: string): string {
  try {
    const meta: unknown = JSON.parse(readTextIfExists(metaFile) ?? "null");
    const source = typeof meta === "object" && meta !== null ? (meta as { source?: unknown }).source : undefined;
    return typeof source === "string" ? source : "a real capture taken by the Mac";
  } catch {
    return "a real capture taken by the Mac";
  }
}

/**
 * Files a capture the mark tool took after the mark itself was filed. True when the mark
 * exists and now has its capture.
 */
export function attachCapture(sessionDir: string, state: IngestState, commandId: string): boolean {
  const mark = findMarkByCommand(state, commandId);
  if (!mark) return false;
  const markDir = path.join(sessionDir, mark.dir);
  const markFile = readMarkFile(markDir);
  if (!attachCaptureFile(sessionDir, markDir, markFile)) return false;
  writeMarkFile(markDir, markFile);
  return true;
}

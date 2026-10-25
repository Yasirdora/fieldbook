/**
 * Ingest: turns the copied mailbox into the session bundle. New events go to
 * timeline.jsonl; marks get their own folder; snapshots and MetricKit files are copied.
 * Ingest remembers what it has seen (raw/ingest.json), so pulling twice files nothing twice.
 */
import fs from "node:fs";
import path from "node:path";
import { parseEvents, parseHello, parseSnapshotInfo, type Hello, type MailboxEvent, type SnapshotInfo } from "../format.ts";
import { readJson, readTextIfExists, slugify, writeJsonAtomic } from "../fsx.ts";
import { captured, measured, missing, rendered, reported, type Labeled } from "../labels.ts";
import type { SessionFile, TimelineEntry } from "./store.ts";

/** Events may be up to this much older than the session start (the two clocks can differ a little). */
export const CLOCK_MARGIN_MS = 2_000;

type Pending =
  | { kind: "markSnapshot"; snapshotId: string; markId: string }
  | { kind: "snapshot"; snapshotId: string }
  | { kind: "metrickit"; file: string };

export interface IngestState {
  formatVersion: 1;
  /** Highest event seq seen, per run. */
  eventSeq: Record<string, number>;
  /** App mark id → the session's mark number and folder. */
  marks: Record<string, { n: number; dir: string }>;
  /** Command id → app mark id, for captures that arrive after the mark. */
  marksByCommand: Record<string, string>;
  nextMark: number;
  /** Files the event named but the copy did not have yet. Tried again on the next pull. */
  pending: Pending[];
  /** Notes whose mark was not filed yet. */
  pendingNotes: { markId: string; text: string }[];
  skippedLines: number;
}

export interface IngestResult {
  entries: TimelineEntry[];
  marksFiled: number[];
  /** Highest outbox seq in the copied mailbox (for the ack). */
  outboxMax: number;
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
  return { formatVersion: 1, eventSeq: {}, marks: {}, marksByCommand: {}, nextMark: 1, pending: [], pendingNotes: [], skippedLines: 0 };
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

export function ingest(root: string, sessionDir: string, session: SessionFile, state: IngestState): IngestResult {
  const context = new IngestRun(root, sessionDir, session, state);
  return context.run();
}

/** One ingest pass. */
class IngestRun {
  private readonly entries: TimelineEntry[] = [];
  private readonly marksFiled: number[] = [];
  private readonly startedMs: number;
  private readonly root: string;
  private readonly sessionDir: string;
  private readonly state: IngestState;

  constructor(root: string, sessionDir: string, session: SessionFile, state: IngestState) {
    this.root = root;
    this.sessionDir = sessionDir;
    this.state = state;
    this.startedMs = Date.parse(session.startedAt);
  }

  run(): IngestResult {
    const result: IngestResult = { entries: this.entries, marksFiled: this.marksFiled, outboxMax: this.outboxMax() };
    const helloText = readTextIfExists(path.join(this.root, "hello.json"));
    if (helloText !== undefined) {
      try {
        result.hello = parseHello(helloText);
      } catch (error) {
        result.helloProblem = (error as Error).message;
      }
    }
    for (const event of this.newEvents()) this.handle(event);
    this.retryPending();
    return result;
  }

  private newEvents(): MailboxEvent[] {
    const fresh: MailboxEvent[] = [];
    for (const name of ["events.1.jsonl", "events.jsonl"]) {
      const text = readTextIfExists(path.join(this.root, name));
      if (text === undefined) continue;
      const { events, skipped } = parseEvents(text);
      this.state.skippedLines += skipped;
      for (const event of events) {
        if (event.seq <= (this.state.eventSeq[event.runId] ?? 0)) continue;
        this.state.eventSeq[event.runId] = event.seq;
        if (Date.parse(event.time) >= this.startedMs - CLOCK_MARGIN_MS) fresh.push(event);
      }
    }
    return fresh;
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
    const n = this.state.nextMark++;
    const dir = `marks/${n}-${slugify(mark.name ?? mark.source)}`;
    this.state.marks[mark.id] = { n, dir };
    if (mark.commandId) this.state.marksByCommand[mark.commandId] = mark.id;
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
      commandId: mark.commandId ?? null,
      snapshotId: mark.snapshotId,
      snapshot: null,
      parts: {
        tree: missing("the snapshot was not copied yet"),
        ax: missing("the snapshot was not copied yet"),
        state: missing("the snapshot was not copied yet"),
        screenRendered: missing("the snapshot was not copied yet"),
        screenCaptured: mark.commandId
          ? missing("the Mac has not filed a capture for this mark yet")
          : missing("marked on the device; the Mac took no capture at that moment"),
        note: missing("the tester wrote no note"),
      },
    };
    if (!this.copyMarkSnapshot(absolute, markFile)) {
      this.state.pending.push({ kind: "markSnapshot", snapshotId: mark.snapshotId, markId: mark.id });
    }
    if (mark.commandId) attachCaptureFile(this.sessionDir, absolute, markFile);
    writeMarkFile(absolute, markFile);
    for (const note of this.state.pendingNotes.filter((pending) => pending.markId === mark.id)) {
      addNote(absolute, note.text);
    }
    this.state.pendingNotes = this.state.pendingNotes.filter((pending) => pending.markId !== mark.id);
    this.marksFiled.push(n);
    this.entries.push(
      this.entry(event, event.time, "measured", { n, id: mark.id, name: mark.name ?? null, source: mark.source, dir, commandId: mark.commandId ?? null }),
    );
  }

  /** Copies the snapshot files into the mark folder. False when the snapshot is not in the copy yet. */
  private copyMarkSnapshot(markDir: string, markFile: MarkFile): boolean {
    const copied = copySnapshot(this.root, markFile.snapshotId, markDir);
    if (!copied) return false;
    for (const part of SNAPSHOT_PARTS) {
      markFile.parts[part.part] = copied.files.includes(part.file) ? part.label(part.file) : missing(`not in this snapshot`);
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
    const mark = this.state.marks[markId];
    if (mark) {
      const absolute = path.join(this.sessionDir, mark.dir);
      addNote(absolute, text);
    } else {
      this.state.pendingNotes.push({ markId, text });
    }
    this.entries.push(this.entry(event, event.time, "reported", { n: mark?.n ?? null, markId, text }));
  }

  // -- on-demand snapshots and MetricKit -------------------------------------

  private fileSnapshot(event: Extract<MailboxEvent, { kind: "snapshot" }>): void {
    const id = event.snapshot.id;
    this.state.pending.push({ kind: "snapshot", snapshotId: id });
    this.entries.push(this.entry(event, event.time, "measured", { ...event.snapshot, dir: `snapshots/${id}` }));
  }

  private retryPending(): void {
    this.state.pending = this.state.pending.filter((pending) => !this.tryPending(pending));
  }

  /** True when the pending copy is done. */
  private tryPending(pending: Pending): boolean {
    switch (pending.kind) {
      case "markSnapshot": {
        const mark = this.state.marks[pending.markId];
        if (!mark) return true;
        const absolute = path.join(this.sessionDir, mark.dir);
        const markFile = readMarkFile(absolute);
        if (!this.copyMarkSnapshot(absolute, markFile)) return false;
        writeMarkFile(absolute, markFile);
        return true;
      }
      case "snapshot":
        return copySnapshot(this.root, pending.snapshotId, path.join(this.sessionDir, "snapshots", pending.snapshotId)) !== undefined;
      case "metrickit":
        return copyMetricKit(this.root, pending.file, path.join(this.sessionDir, "metrickit"));
    }
  }

  private outboxMax(): number {
    const outbox = path.join(this.root, "outbox");
    if (!fs.existsSync(outbox)) return 0;
    return fs
      .readdirSync(outbox)
      .map((name) => Number.parseInt(name, 10))
      .filter((seq) => Number.isFinite(seq))
      .reduce((max, seq) => Math.max(max, seq), 0);
  }
}

function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith(".");
}

/** Copies snapshots/<id>/ from the mailbox copy. Undefined when it is not there (yet). */
function copySnapshot(root: string, snapshotId: string, destination: string): { files: string[]; info: SnapshotInfo } | undefined {
  if (!isSafeName(snapshotId)) return undefined;
  const source = path.join(root, "snapshots", snapshotId);
  const infoText = readTextIfExists(path.join(source, "snapshot.json"));
  if (infoText === undefined) return undefined;
  let info: SnapshotInfo;
  try {
    info = parseSnapshotInfo(infoText);
  } catch {
    return undefined;
  }
  fs.mkdirSync(destination, { recursive: true });
  const files = fs.readdirSync(source).filter((name) => !name.startsWith(".") && name !== "snapshot.json");
  for (const file of files) fs.copyFileSync(path.join(source, file), path.join(destination, file));
  fs.copyFileSync(path.join(source, "snapshot.json"), path.join(destination, "snapshot.json"));
  return { files, info };
}

function copyMetricKit(root: string, relative: string, destinationDir: string): boolean {
  const parts = relative.split("/");
  if (parts.length !== 2 || parts[0] !== "metrickit" || !isSafeName(parts[1] as string)) return true;
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, path.join(destinationDir, parts[1] as string));
  return true;
}

export function readMarkFile(markDir: string): MarkFile {
  return readJson<MarkFile>(path.join(markDir, "mark.json"));
}

export function writeMarkFile(markDir: string, markFile: MarkFile): void {
  writeJsonAtomic(path.join(markDir, "mark.json"), markFile);
}

function addNote(markDir: string, text: string): void {
  fs.appendFileSync(path.join(markDir, "note.txt"), `${text}\n`);
  const markFile = readMarkFileIfExists(markDir);
  if (!markFile) return;
  markFile.parts.note = reported("note.txt", "the tester's words");
  writeMarkFile(markDir, markFile);
}

function readMarkFileIfExists(markDir: string): MarkFile | undefined {
  return fs.existsSync(path.join(markDir, "mark.json")) ? readMarkFile(markDir) : undefined;
}

/** Copies the Mac's real screenshot for this mark's command into the mark folder, if there is one. */
function attachCaptureFile(sessionDir: string, markDir: string, markFile: MarkFile): boolean {
  if (!markFile.commandId) return false;
  const file = capturePath(sessionDir, markFile.commandId);
  if (!fs.existsSync(file)) return false;
  fs.copyFileSync(file, path.join(markDir, "screen-captured.png"));
  const meta = readTextIfExists(`${file.slice(0, -4)}.json`);
  const source = meta ? (JSON.parse(meta) as { source?: string }).source : undefined;
  markFile.parts.screenCaptured = captured("screen-captured.png", source ?? "a real capture taken by the Mac");
  return true;
}

/**
 * Files a capture the mark tool took after the mark itself was filed. True when the mark
 * exists and now has its capture.
 */
export function attachCapture(sessionDir: string, state: IngestState, commandId: string): boolean {
  const markId = state.marksByCommand[commandId];
  const mark = markId ? state.marks[markId] : undefined;
  if (!mark) return false;
  const markDir = path.join(sessionDir, mark.dir);
  const markFile = readMarkFile(markDir);
  if (!attachCaptureFile(sessionDir, markDir, markFile)) return false;
  writeMarkFile(markDir, markFile);
  return true;
}

/**
 * A fake FieldbookKit for server tests: it writes a mailbox the way the Swift kit does
 * (docs/FORMAT.md) and answers commands from its inbox. Snapshots copy the shared fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { FORMAT_FIXTURES } from "../helpers.ts";

const SNAPSHOT_TEMPLATE = path.join(FORMAT_FIXTURES, "mailbox/snapshots/5c1e0a2b-0001");

export interface FakeKitOptions {
  bundleId: string;
  now: () => Date;
  runId?: string;
  executable?: string;
  platform?: "iOS" | "macOS";
  /** When true, snapshot commands are answered with ok: false (the kit could not store the snapshot). */
  failSnapshots?: boolean;
  /** Changes the copied tree.json and ax.json of every snapshot (to fake a UI change). */
  editTrees?: (tree: any, ax: any) => void;
}

export class FakeKit {
  readonly dir: string;
  readonly runId: string;
  private readonly options: FakeKitOptions;
  private seq = 0;
  private outboxSeq = 0;
  private snapshots = 0;
  private marks = 0;
  private metricKitCount = 0;

  constructor(dir: string, options: FakeKitOptions) {
    this.dir = dir;
    this.options = options;
    this.runId = options.runId ?? "5C1E0A2B-7D4F-4B8A-9E61-0F3D2C1B0A99";
    for (const folder of ["inbox", "outbox", "snapshots", "metrickit"]) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
    }
  }

  private get prefix(): string {
    return this.runId.slice(0, 8).toLowerCase();
  }

  private now(): string {
    return this.options.now().toISOString();
  }

  /** hello.json plus the lifecycle and launch events of a fresh launch. */
  launch(launchMs = 391): this {
    const hello = {
      appBuild: "7",
      appName: "Sparrowpad",
      appVersion: "1.0",
      bundleId: this.options.bundleId,
      commit: "a1b2c3d",
      deviceModel: this.options.platform === "macOS" ? "Mac15,3" : "iPhone13,3",
      executable: this.options.executable ?? "Sparrowpad",
      formatVersion: 1,
      hangThresholdMs: 250,
      isSimulator: false,
      osVersion: this.options.platform === "macOS" ? "27.0" : "27.0.1",
      pid: 4242,
      platform: this.options.platform ?? "iOS",
      probeVersion: "0.1.0",
      processStart: this.now(),
      redaction: "hashed",
      runId: this.runId,
      writtenAt: this.now(),
    };
    fs.writeFileSync(path.join(this.dir, "hello.json"), JSON.stringify(hello));
    this.event("lifecycle", { state: "active" });
    this.event("launch", { ms: launchMs });
    return this;
  }

  event(kind: string, payload: unknown, time?: Date): void {
    this.seq++;
    const line = { formatVersion: 1, kind, [kind]: payload, runId: this.runId, seq: this.seq, time: (time ?? this.options.now()).toISOString() };
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), `${JSON.stringify(line)}\n`);
  }

  log(level: string, message: string, category = "list"): void {
    this.event("log", { level, subsystem: this.options.bundleId, category, message, cut: false, logTime: this.now() });
  }

  hang(ms: number): void {
    this.event("hang", { start: new Date(this.options.now().getTime() - ms).toISOString(), ms });
  }

  memory(footprint: number, peak: number): void {
    this.event("memory", { footprint, peak });
  }

  /** A mark from a shake (no command). A name stands in for a mark sent from the Mac. */
  shake(name?: string): string {
    return this.mark({ source: name ? "command" : "shake", name });
  }

  note(markId: string, text: string): void {
    this.event("note", { markId, text });
  }

  /** Reads and answers every command in the inbox, like the kit does. */
  respond(via: "notification" | "poll" = "notification"): number {
    const inbox = path.join(this.dir, "inbox");
    const files = fs.readdirSync(inbox).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
    for (const name of files) {
      const command = JSON.parse(fs.readFileSync(path.join(inbox, name), "utf8"));
      fs.rmSync(path.join(inbox, name));
      this.event("command", { id: command.id, name: command.name, via });
      this.handle(command, via);
    }
    return files.length;
  }

  private handle(command: { id: string; name: string; args: Record<string, unknown> }, via: string): void {
    switch (command.name) {
      case "mark":
        this.mark({ source: "command", name: command.args.name as string | undefined, commandId: command.id, via });
        break;
      case "snapshot": {
        if (this.options.failSnapshots) {
          this.outbox("result", { commandId: command.id, commandName: "snapshot", via, ok: false, message: "The snapshot could not be stored.", snapshotId: null });
          break;
        }
        const snapshotId = this.snapshot("command", undefined, command.id);
        this.outbox("result", { commandId: command.id, commandName: "snapshot", via, ok: true, snapshotId });
        break;
      }
      case "ping":
        this.outbox("result", { commandId: command.id, commandName: "ping", via, ok: true, message: "pong" });
        break;
      case "ack":
        this.prune(command.args.upTo as number);
        break;
    }
  }

  private mark(input: { source: string; name?: string; commandId?: string; via?: string }): string {
    this.marks++;
    const markId = `${this.prefix}-m${this.marks}`;
    const snapshotId = this.snapshot("mark", markId, input.commandId);
    this.event("mark", {
      id: markId,
      number: this.marks,
      name: input.name ?? null,
      source: input.source,
      snapshotId,
      commandId: input.commandId ?? null,
    });
    this.outbox("mark", {
      commandId: input.commandId ?? null,
      commandName: input.commandId ? "mark" : null,
      via: input.via ?? null,
      ok: true,
      snapshotId,
      markId,
    });
    return markId;
  }

  private snapshot(reason: "mark" | "command", markId?: string, commandId?: string): string {
    this.snapshots++;
    const id = `${this.prefix}-${String(this.snapshots).padStart(4, "0")}`;
    const target = path.join(this.dir, "snapshots", id);
    fs.cpSync(SNAPSHOT_TEMPLATE, target, { recursive: true });
    const info = JSON.parse(fs.readFileSync(path.join(target, "snapshot.json"), "utf8"));
    Object.assign(info, { id, reason, markId: markId ?? null, commandId: commandId ?? null, time: this.now() });
    fs.writeFileSync(path.join(target, "snapshot.json"), JSON.stringify(info));
    if (this.options.editTrees) {
      const treeFile = path.join(target, "tree.json");
      const axFile = path.join(target, "ax.json");
      const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
      const ax = JSON.parse(fs.readFileSync(axFile, "utf8"));
      this.options.editTrees(tree, ax);
      fs.writeFileSync(treeFile, JSON.stringify(tree));
      fs.writeFileSync(axFile, JSON.stringify(ax));
    }
    if (this.options.platform === "macOS") {
      // AppKit snapshots carry the window number the Mac needs for `screencapture -l`.
      const tree = JSON.parse(fs.readFileSync(path.join(target, "tree.json"), "utf8"));
      tree.windows[0].number = 4242;
      fs.writeFileSync(path.join(target, "tree.json"), JSON.stringify(tree));
    }
    this.event("snapshot", { id, reason, ms: 84, nodes: 5, axNodes: 3, truncated: false });
    return id;
  }

  private outbox(kind: string, fields: Record<string, unknown>): void {
    this.outboxSeq++;
    const item = { formatVersion: 1, seq: this.outboxSeq, runId: this.runId, time: this.now(), kind, file: null, message: null, ...fields };
    const name = `${String(this.outboxSeq).padStart(6, "0")}-${kind}.json`;
    fs.writeFileSync(path.join(this.dir, "outbox", name), JSON.stringify(item));
  }

  private prune(upTo: number): void {
    const outbox = path.join(this.dir, "outbox");
    for (const name of fs.readdirSync(outbox)) {
      if (Number.parseInt(name, 10) > upTo) continue;
      const item = JSON.parse(fs.readFileSync(path.join(outbox, name), "utf8"));
      if (item.snapshotId) fs.rmSync(path.join(this.dir, "snapshots", item.snapshotId), { recursive: true, force: true });
      fs.rmSync(path.join(outbox, name));
    }
  }

  /** A MetricKit payload, stored like the kit stores it. Returns its path in the mailbox. */
  metricKit(type: "metrics" | "diagnostics"): string {
    this.metricKitCount++;
    const file = `metrickit/${this.options.now().getTime()}-${this.metricKitCount}-${type}.json`;
    fs.writeFileSync(path.join(this.dir, file), JSON.stringify({ timeStampBegin: this.now(), invented: true }));
    this.event("metrickit", { file, type });
    this.outbox("metrickit", { ok: true, file });
    return file;
  }

  outboxNames(): string[] {
    return fs.readdirSync(path.join(this.dir, "outbox")).sort();
  }

  inboxNames(): string[] {
    return fs.readdirSync(path.join(this.dir, "inbox")).sort();
  }
}

/** A clock tests move by hand. */
export class TestClock {
  private ms: number;
  constructor(start = "2026-11-04T10:15:00.000Z") {
    this.ms = Date.parse(start);
  }
  readonly now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

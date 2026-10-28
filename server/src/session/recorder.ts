/**
 * Recorder: one recording session in this server process. It pulls the mailbox on a timer,
 * sends commands, records the console when the app was relaunched, and closes the session.
 * Pulls and commands run one at a time.
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import type { Device, Launch } from "../devices/types.ts";
import { isCrashLogOf } from "../devices/types.ts";
import type { ExecResult } from "../exec.ts";
import { buildCommand, commandFileName, type Command, type CommandArgs, type CommandName } from "../format.ts";
import { measured, missing, reported, type Labeled } from "../labels.ts";
import { ingest, loadIngestState, saveIngestState, type IngestResult, type IngestState } from "./ingest.ts";
import type { SessionFile, SessionStore, TimelineEntry } from "./store.ts";

export interface PullReport {
  ok: boolean;
  problem?: string;
  entries: number;
  marksFiled: number[];
}

export interface SentCommand {
  command: Command;
  sent: Labeled<true>;
  notified: Labeled<true>;
}

export class Recorder {
  readonly device: Device;
  private readonly ctx: Context;
  private readonly store: SessionStore;
  private session: SessionFile;
  private state: IngestState;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private console: { controller: AbortController; done: Promise<ExecResult> } | undefined;

  constructor(ctx: Context, store: SessionStore, device: Device, session: SessionFile) {
    this.ctx = ctx;
    this.store = store;
    this.device = device;
    this.session = session;
    this.state = loadIngestState(store.dir(session.id));
  }

  get id(): string {
    return this.session.id;
  }

  get current(): SessionFile {
    return this.session;
  }

  get dir(): string {
    return this.store.dir(this.session.id);
  }

  get ingestState(): IngestState {
    return this.state;
  }

  /** Runs `work` after everything queued before it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pullOnce().catch(() => undefined);
    }, this.session.pullSeconds * 1000);
    this.timer.unref();
  }

  pullOnce(): Promise<PullReport> {
    return this.serial(() => this.pull());
  }

  sendCommand(name: CommandName, args: CommandArgs = {}): Promise<SentCommand> {
    return this.serial(() => this.send(name, args));
  }

  /** Copies the mailbox, files what is new, and acknowledges the outbox items it copied. */
  private async pull(): Promise<PullReport> {
    const staging = path.join(this.dir, "raw", "pull");
    const pulled = await this.device.pullMailbox(this.session.bundleId, staging);
    this.session.pulls.lastAt = this.ctx.now().toISOString();
    if (pulled.label === "missing" || !pulled.value) {
      this.session.pulls.lastProblem = pulled.reason ?? "the mailbox could not be copied";
      this.save();
      return { ok: false, problem: this.session.pulls.lastProblem, entries: 0, marksFiled: [] };
    }
    const result = ingest(pulled.value, this.dir, this.session, this.state, this.ctx.now());
    this.store.appendTimeline(this.session.id, result.entries);
    saveIngestState(this.dir, this.state);
    this.session.pulls.count++;
    this.session.pulls.lastProblem = result.helloProblem ?? null;
    this.applyHello(result);
    this.save();
    if (result.ackUpTo > this.session.commands.ackedUpTo) {
      await this.send("ack", { upTo: result.ackUpTo });
      this.session.commands.ackedUpTo = result.ackUpTo;
      this.save();
    }
    return { ok: true, entries: result.entries.length, marksFiled: result.marksFiled };
  }

  /** The app's own words about itself fill what the device could not tell. Never upgrades a label. */
  private applyHello(result: IngestResult): void {
    const hello = result.hello;
    if (!hello || hello.runId === this.session.hello?.runId) return;
    this.session.hello = hello;
    const app = this.session.app;
    const source = "the app's hello.json";
    if (app.version.label === "missing") app.version = reported(hello.appVersion, source);
    if (app.build.label === "missing") app.build = reported(hello.appBuild, source);
    if (app.name.label === "missing") app.name = reported(hello.appName, source);
    app.executable = reported(hello.executable, source);
    app.commit = hello.commit ? reported(hello.commit, source) : missing("the app's Info.plist has no FieldbookCommit");
    const device = this.session.device;
    if (device.model.label === "missing") device.model = reported(hello.deviceModel, source);
    if (device.osVersion.label === "missing") device.osVersion = reported(hello.osVersion, source);
  }

  private async send(name: CommandName, args: CommandArgs): Promise<SentCommand> {
    const seq = this.session.commands.nextSeq++;
    this.save();
    const command: Command = {
      formatVersion: 1,
      id: `${this.session.id}-${seq}`,
      seq,
      name,
      sentAt: this.ctx.now().toISOString(),
      args,
    };
    const fileName = commandFileName(seq, name);
    const local = path.join(this.dir, "raw", "commands", fileName);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buildCommand({ ...command, sentAt: new Date(command.sentAt) }));
    const sent = await this.device.sendCommand(this.session.bundleId, local, fileName);
    const notified = sent.label === "missing" ? missing<true>("the command was not sent") : await this.device.notifyInbox(this.session.bundleId);
    return { command, sent, notified };
  }

  /** Relaunches the app and appends its printed output to console.log. */
  startConsole(args: readonly string[]): Launch {
    const controller = new AbortController();
    const consoleFile = path.join(this.dir, "console.log");
    const launch = this.device.launch(this.session.bundleId, args, (text) => fs.appendFileSync(consoleFile, text), controller.signal);
    if (launch.started) this.console = { controller, done: launch.done };
    return launch;
  }

  /** The last pull, crash pickup, and the session is closed. */
  stop(): Promise<{ pull: PullReport; newCrashLogs: Labeled<string[]> }> {
    return this.serial(async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const pull = await this.pull();
      const newCrashLogs = await this.pickUpCrashes();
      await this.stopConsole();
      this.session.crashes = newCrashLogs;
      this.session.status = "stopped";
      this.session.endedAt = this.ctx.now().toISOString();
      this.save();
      this.ctx.recorders.delete(this.session.id);
      return { pull, newCrashLogs };
    });
  }

  private async pickUpCrashes(): Promise<Labeled<string[]>> {
    const executable = this.session.app.executable.value ?? this.session.hello?.executable ?? this.session.app.name.value;
    if (!executable) return missing("the app's executable name is unknown (the app never wrote hello.json)");
    const before = this.session.crashLogsAtStart;
    if (before.label === "missing") return missing(`the crash log list at the start could not be read: ${before.reason}`);
    const now = await this.device.crashLogNames();
    if (now.label === "missing") return missing(now.reason ?? "the crash logs could not be listed");
    const fresh = (now.value ?? []).filter((name) => isCrashLogOf(name, executable) && !(before.value ?? []).includes(name));
    const copied: string[] = [];
    const entries: TimelineEntry[] = [];
    for (const name of fresh) {
      const result = await this.device.copyCrashLog(name, path.join(this.dir, "crashes"));
      if (result.label === "missing") {
        this.session.problems.push(result.reason ?? `could not copy ${name}`);
        continue;
      }
      copied.push(name);
      const at = this.ctx.now().toISOString();
      entries.push({ at, ms: Date.parse(at) - Date.parse(this.session.startedAt), kind: "crash", label: "measured", crash: { file: `crashes/${name}` } });
    }
    this.store.appendTimeline(this.session.id, entries);
    return measured(copied, `${now.source}; compared with the list at the start`);
  }

  /** Stops the timer and the console without closing the session (the server is shutting down). */
  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.console?.controller.abort();
  }

  private async stopConsole(): Promise<void> {
    if (!this.console) return;
    this.console.controller.abort();
    await Promise.race([this.console.done, this.ctx.sleep(3_000)]);
    this.console = undefined;
  }

  private save(): void {
    this.store.write(this.session);
  }
}

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
import { failureText } from "../runner.ts";
import { measured, missing, reported, type Labeled } from "../labels.ts";
import { ingest, loadIngestState, saveIngestState, takeBaseline, type IngestResult, type IngestState } from "./ingest.ts";
import type { SessionFile, SessionStore, TimelineEntry } from "./store.ts";

export interface PullReport {
  ok: boolean;
  problem?: string;
  entries: number;
  marksFiled: number[];
}

export interface StopResult {
  pull: PullReport;
  newCrashLogs: Labeled<string[]>;
  copyFailures: string[];
  /** Why stop waited for a crash report, or null when it had no reason to. */
  crashSign: string | null;
}

/**
 * A crash report can appear well after the crash (measured on a simulator: 5.1 s and 17.6 s).
 * When the console shows a fatal error or the app's process ends, stop keeps listing crash
 * logs for up to this long.
 */
export const CRASH_REPORT_WAIT_MS = 45_000;
const CRASH_REPORT_POLL_MS = 2_000;

/** What a crashing app prints last: Swift's runtime trap, or an uncaught Objective-C exception. */
const CRASH_LINE = /Fatal error:|Terminating app due to uncaught exception/;

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
  private stopping: Promise<StopResult> | undefined;
  private crashSign: string | null = null;

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

  /**
   * Notes what the mailbox holds before a relaunch, so everything the new run writes counts,
   * whatever the two clocks say. When the copy fails, the first pull notes it instead.
   */
  noteMailboxBeforeRelaunch(): Promise<void> {
    return this.serial(async () => {
      const pulled = await this.device.pullMailbox(this.session.bundleId, path.join(this.dir, "raw", "pull"));
      if (pulled.label === "missing" || !pulled.value) return;
      this.state.baseline = takeBaseline(pulled.value);
      saveIngestState(this.dir, this.state);
    });
  }

  /** Copies the mailbox, files what is new, and acknowledges the outbox items it copied. */
  private async pull(): Promise<PullReport> {
    if (this.session.status === "stopped") return { ok: false, problem: "the session is stopped", entries: 0, marksFiled: [] };
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
    if (this.session.status === "stopped") {
      const command: Command = { formatVersion: 1, id: "", seq: 0, name, sentAt: this.ctx.now().toISOString(), args };
      return { command, sent: missing("the session is stopped"), notified: missing("the session is stopped") };
    }
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
    let tail = "";
    const onOutput = (text: string) => {
      fs.appendFileSync(consoleFile, text);
      const recent = tail + text;
      if (this.crashSign === null && CRASH_LINE.test(recent)) this.crashSign = "the console showed a fatal error";
      tail = recent.slice(-200);
    };
    const launch = this.device.launch(this.session.bundleId, args, onOutput, controller.signal);
    if (!launch.started) return launch;
    this.console = { controller, done: launch.done };
    void launch.done.then((result) => {
      if (!result.aborted) this.crashSign ??= "the app's process ended";
      if (result.stderr.trim().length > 0) fs.appendFileSync(consoleFile, `\n[stderr of ${launch.command}]\n${result.stderr}`);
      if (!result.aborted && result.code !== 0) {
        this.session.problems.push(`the console ended early: ${failureText(result)}`);
        this.save();
      }
    });
    return launch;
  }

  /** The last pull, crash pickup, and the session is closed. */
  stop(): Promise<StopResult> {
    if (this.stopping) return this.stopping;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const stopping = this.serial(async () => {
      const pull = await this.pull();
      const crashSign = this.crashSign;
      if (crashSign !== null) await this.waitForCrashReport();
      const { listed, copyFailures } = await this.pickUpCrashes();
      await this.stopConsole();
      this.session.crashes = listed;
      this.session.status = "stopped";
      this.session.endedAt = this.ctx.now().toISOString();
      this.save();
      if (this.ctx.recorders.get(this.session.id) === this) this.ctx.recorders.delete(this.session.id);
      return { pull, newCrashLogs: listed, copyFailures, crashSign };
    });
    this.stopping = stopping;
    // Only a stop that finished is kept; one that failed can be tried again.
    stopping.catch(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }

  /** Lists crash logs until a new one of this app is there, for at most CRASH_REPORT_WAIT_MS. */
  private async waitForCrashReport(): Promise<void> {
    for (let waited = 0; waited < CRASH_REPORT_WAIT_MS; waited += CRASH_REPORT_POLL_MS) {
      if ((await this.freshCrashLogNames()).length > 0) return;
      await this.ctx.sleep(CRASH_REPORT_POLL_MS);
    }
  }

  /** Crash logs named like this app's that were not there when the session started. */
  private async freshCrashLogNames(): Promise<string[]> {
    const executable = this.executable();
    const before = this.session.crashLogsAtStart;
    if (!executable || before.label === "missing") return [];
    const now = await this.device.crashLogNames();
    return (now.value ?? []).filter((name) => isCrashLogOf(name, executable) && !(before.value ?? []).includes(name));
  }

  private executable(): string | undefined {
    return this.session.app.executable.value ?? this.session.hello?.executable ?? this.session.app.name.value;
  }

  /**
   * The crash logs of this app that appeared during the session. The count comes from the
   * listing (measured); a log that cannot be copied still counts, and its reason is kept.
   */
  private async pickUpCrashes(): Promise<{ listed: Labeled<string[]>; copyFailures: string[] }> {
    const executable = this.executable();
    if (!executable) return { listed: missing("the app's executable name is unknown (the app never wrote hello.json)"), copyFailures: [] };
    const before = this.session.crashLogsAtStart;
    if (before.label === "missing") return { listed: missing(`the crash log list at the start could not be read: ${before.reason}`), copyFailures: [] };
    const now = await this.device.crashLogNames();
    if (now.label === "missing") return { listed: missing(now.reason ?? "the crash logs could not be listed"), copyFailures: [] };
    const fresh = (now.value ?? []).filter((name) => isCrashLogOf(name, executable) && !(before.value ?? []).includes(name));
    const counted: string[] = [];
    const copyFailures: string[] = [];
    const entries: TimelineEntry[] = [];
    for (const name of fresh) {
      const result = await this.device.copyCrashLog(name, path.join(this.dir, "crashes"));
      const copied = result.label !== "missing";
      const owner = copied ? crashBundleId(result.value as string) : undefined;
      if (owner !== undefined && owner !== this.session.bundleId) {
        fs.rmSync(result.value as string, { force: true });
        continue;
      }
      if (!copied) {
        const why = `${name} could not be copied: ${result.reason ?? "unknown reason"}`;
        copyFailures.push(why);
        this.session.problems.push(why);
      }
      counted.push(name);
      const at = (copied ? crashTime(result.value as string) : undefined) ?? this.ctx.now().toISOString();
      entries.push({
        at,
        ms: Date.parse(at) - Date.parse(this.session.startedAt),
        kind: "crash",
        label: "measured",
        crash: { name, file: copied ? `crashes/${name}` : null },
      });
    }
    this.store.appendTimeline(this.session.id, entries);
    return { listed: measured(counted, `${now.source}; compared with the list at the start; bundle id checked in each copied log`), copyFailures };
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

/** Crash reports above this size are not parsed (a real one is about 100 KB). */
const CRASH_REPORT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A crash report (.ips) is a JSON header line followed by the report as one JSON object.
 * Either part is undefined when it is missing or not an object.
 */
function crashReport(file: string): { header?: Record<string, unknown>; body?: Record<string, unknown> } {
  try {
    if (fs.statSync(file).size > CRASH_REPORT_MAX_BYTES) return {};
    const text = fs.readFileSync(file, "utf8");
    const split = text.indexOf("\n");
    const object = (part: string): Record<string, unknown> | undefined => {
      try {
        const value: unknown = JSON.parse(part);
        return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    return split < 0 ? { header: object(text) } : { header: object(text.slice(0, split)), body: object(text.slice(split + 1)) };
  } catch {
    return {};
  }
}

/** The bundle id in a crash report's header, if it has one. */
function crashBundleId(file: string): string | undefined {
  const bundleId = crashReport(file).header?.bundleID;
  return typeof bundleId === "string" ? bundleId : undefined;
}

/**
 * When the crash happened, as an ISO time: the report's "captureTime". The header's
 * "timestamp" is when the report was written (measured on a simulator: 5.1 s after the
 * capture) and is used only when the body has no capture time. The pickup can be later still.
 */
export function crashTime(file: string): string | undefined {
  const { header, body } = crashReport(file);
  return reportTime(body?.captureTime) ?? reportTime(header?.timestamp);
}

/** "2026-11-05 10:20:03.8805 +0100" as an ISO time. */
function reportTime(stamp: unknown): string | undefined {
  if (typeof stamp !== "string") return undefined;
  const parts = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-])(\d{2})(\d{2})$/.exec(stamp.trim());
  if (!parts) return undefined;
  const fraction = (parts[3] ?? "").slice(0, 4);
  const time = Date.parse(`${parts[1]}T${parts[2]}${fraction}${parts[4]}${parts[5]}:${parts[6]}`);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * session_start and session_stop.
 *
 * session_start records the device, the app's version and build, and hello.json, then pulls
 * the mailbox on a timer. It relaunches the app only when asked (relaunch: true). A locked
 * phone gets "Unlock the phone", and nothing starts.
 */
import fs from "node:fs";
import type { Context } from "../context.ts";
import { DeviceChoiceError, resolveDevice } from "../devices/registry.ts";
import type { Device, Target } from "../devices/types.ts";
import { LAUNCH_ARGUMENT_SETS } from "../allowlist.ts";
import { describe, missing, type Labeled } from "../labels.ts";
import type { ExecResult } from "../exec.ts";
import { failureText } from "../runner.ts";
import { recorderFor } from "../session/open.ts";
import { Recorder, type PullReport } from "../session/recorder.ts";
import { sessionMetrics } from "../session/metrics.ts";
import { SessionStore, type SessionFile } from "../session/store.ts";
import { formatBytes, formatDuration, plural, ToolError, type ToolAnswer } from "./common.ts";

export interface SessionStartInput {
  target: Target;
  device?: string;
  bundleId: string;
  label: string;
  build?: string;
  change?: string;
  relaunch?: boolean;
  /** Relaunch with -FieldbookText full, so view text is stored in full. Needs relaunch. */
  fullText?: boolean;
  pullSeconds?: number;
}

export interface SessionStartData {
  started: boolean;
  session: { id: string; dir: string } | null;
  device?: { target: Target; id: string; name: string };
  firstPull?: PullReport;
}

function notStarted(summary: string, device?: Device): ToolAnswer<SessionStartData> {
  return {
    summary,
    data: { started: false, session: null, device: device ? { target: device.target, id: device.id, name: device.name } : undefined },
  };
}

function deviceTitle(device: Device | SessionFile["device"], target: Target): string {
  const model = device.model.value;
  const os = device.osVersion.value ? `${target === "mac" ? "macOS" : "iOS"} ${device.osVersion.value}` : undefined;
  const facts = [model, os].filter(Boolean).join(", ");
  return `${target === "mac" ? "this Mac" : target} "${device.name}"${facts ? ` (${facts})` : ""}`;
}

export async function sessionStart(ctx: Context, input: SessionStartInput): Promise<ToolAnswer<SessionStartData>> {
  if (input.fullText && !input.relaunch) {
    return notStarted("Full text needs relaunch: true, because the app reads -FieldbookText full only at launch. Nothing was started.");
  }
  let device: Device;
  try {
    device = await resolveDevice(ctx, input.target, input.device);
  } catch (error) {
    if (error instanceof DeviceChoiceError) return notStarted(`${error.message} Nothing was started.`);
    throw error;
  }
  const busy = recordingSession(new SessionStore(ctx.home), device, input.bundleId);
  if (busy) {
    return notStarted(`Session ${busy} is already recording ${input.bundleId} on ${device.name}. Stop it first (session_stop), then start again.`, device);
  }
  const refusal = await checkReady(device, input);
  if (refusal) return notStarted(refusal, device);
  const app = await device.appStatus(input.bundleId);
  if (app.installed.value === false) return notStarted(`${input.bundleId} is not installed on ${device.name}. Nothing was started.`, device);
  if (app.containerAccess.value !== true) {
    return notStarted(
      `Fieldbook cannot read the app's container on ${device.name}: ${describe(app.containerAccess)}. Install the app from Xcode (a development build). Nothing was started.`,
      device,
    );
  }
  return startRecording(ctx, device, input, app);
}

/** The id of a session that is still recording this app on this device, if any. */
function recordingSession(store: SessionStore, device: Device, bundleId: string): string | undefined {
  return store
    .list()
    .map((id) => store.read(id))
    .find((session) => session.status === "recording" && session.target === device.target && session.device.id === device.id && session.bundleId === bundleId)?.id;
}

/** A reason not to start, or undefined when the device is ready. */
async function checkReady(device: Device, input: SessionStartInput): Promise<string | undefined> {
  if (input.relaunch && device.target === "mac") {
    return "Fieldbook cannot relaunch a Mac app; start it from Xcode, then start the session without relaunch. Nothing was started.";
  }
  const probe = await device.probe();
  if (probe.reachable.value !== true) {
    return `The ${device.target} "${device.name}" is not reachable: ${probe.reachable.source ?? probe.reachable.reason}. Nothing was started.`;
  }
  if (probe.locked.value === true) return `Unlock the phone "${device.name}", then start the session again. Nothing was started.`;
  return undefined;
}

async function startRecording(
  ctx: Context,
  device: Device,
  input: SessionStartInput,
  app: Awaited<ReturnType<Device["appStatus"]>>,
): Promise<ToolAnswer<SessionStartData>> {
  const store = new SessionStore(ctx.home);
  const now = ctx.now();
  const id = store.newId(input.label, now);
  fs.mkdirSync(store.dir(id), { recursive: true });
  const notKnown = missing<string>("not known yet");
  const session: SessionFile = {
    formatVersion: 1,
    id,
    label: input.label,
    target: device.target,
    bundleId: input.bundleId,
    build: input.build ?? null,
    change: input.change ?? null,
    status: "recording",
    startedAt: now.toISOString(),
    endedAt: null,
    relaunched: false,
    fullText: Boolean(input.fullText),
    device: { id: device.id, name: device.name, model: device.model, osVersion: device.osVersion },
    app: {
      installed: app.installed,
      containerAccess: app.containerAccess,
      name: app.name ?? notKnown,
      executable: notKnown,
      version: app.version ?? missing("the device does not list app versions; read from hello.json"),
      build: app.build ?? missing("the device does not list app builds; read from hello.json"),
      commit: notKnown,
    },
    hello: null,
    pullSeconds: input.pullSeconds ?? ctx.config.pullSeconds,
    pulls: { count: 0, lastAt: null, lastProblem: null },
    commands: { nextSeq: 1, ackedUpTo: 0 },
    crashLogsAtStart: await device.crashLogNames(),
    crashes: missing("picked up when the session stops"),
    problems: [],
  };
  store.write(session);
  const recorder = new Recorder(ctx, store, device, session);
  ctx.recorders.set(id, recorder);
  const relaunchLine = input.relaunch ? await relaunch(ctx, recorder, input) : "The app was not relaunched; Fieldbook records from now.";
  const firstPull = await recorder.pullOnce();
  if (ctx.autoPull) recorder.startTimer();
  const current = recorder.current;
  const lines = [
    `Recording session ${id} "${input.label}" on ${deviceTitle(current.device, device.target)}.`,
    `App ${input.bundleId}: version ${describe(current.app.version)}, build ${describe(current.app.build)}, commit ${describe(current.app.commit)}.`,
    relaunchLine,
    `Pulling the mailbox every ${current.pullSeconds} s. First pull: ${
      firstPull.ok ? `${plural(firstPull.entries, "new timeline entry", "new timeline entries")}.` : `nothing yet — ${firstPull.problem}`
    }`,
    ...textModeLine(current, input),
    `Build: ${input.build ?? "not given"}. Change: ${input.change ?? "not given"}.`,
  ];
  return { summary: lines.join("\n"), data: { started: true, session: { id, dir: store.dir(id) }, device: { target: device.target, id: device.id, name: device.name }, firstPull } };
}

/** How long a relaunch may take to fail before Fieldbook calls it started. */
const RELAUNCH_SETTLE_MS = 2_000;

/** When full text was asked for, what the app itself reports (it may set hashed text in code). */
function textModeLine(session: SessionFile, input: SessionStartInput): string[] {
  if (!input.fullText) return [];
  const hello = session.hello;
  if (!hello || Date.parse(hello.processStart) < Date.parse(session.startedAt) - 2_000) {
    return ["The app has not reported its text mode yet; the timeline header shows it once it does."];
  }
  return hello.redaction === "full"
    ? ["The app reports full text (reported by the app)."]
    : ["But the app reports hashed text: it sets the redaction in code, so view text is NOT stored in full."];
}

async function relaunch(ctx: Context, recorder: Recorder, input: SessionStartInput): Promise<string> {
  const args = input.fullText ? (LAUNCH_ARGUMENT_SETS[1] as readonly string[]) : [];
  const launch = recorder.startConsole(args);
  if (!launch.started) return `The app was NOT relaunched: ${launch.reason}`;
  let ended: ExecResult | undefined;
  void launch.done.then((result) => {
    ended = result;
  });
  await ctx.sleep(RELAUNCH_SETTLE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = ended as ExecResult | undefined;
  if (failed && !failed.aborted && failed.code !== 0) return `The app was NOT relaunched: ${failureText(failed)}`;
  const session = recorder.current;
  session.relaunched = true;
  const text = input.fullText ? " It was asked to store view text in full (-FieldbookText full)." : "";
  return `The app was relaunched (${launch.command} … --terminate-existing); its printed output goes to console.log.${text}`;
}

export interface SessionStopData {
  session: string;
  status: "stopped";
  dir: string;
  newCrashLogs: Labeled<string[]>;
  copyFailures: string[];
}

export async function sessionStop(ctx: Context, input: { session: string }): Promise<ToolAnswer<SessionStopData | { session: string; status: "stopped" }>> {
  const store = new SessionStore(ctx.home);
  const session = store.read(input.session);
  if (session.status === "stopped") {
    return { summary: `Session ${session.id} was already stopped at ${session.endedAt}.`, data: { session: session.id, status: "stopped" } };
  }
  const recorder = await recorderFor(ctx, store, session);
  const { pull, newCrashLogs, copyFailures } = await recorder.stop();
  const stopped = recorder.current;
  const metrics = sessionMetrics(stopped, store.readTimeline(stopped.id), ctx.config.rules);
  const duration = formatDuration(Date.parse(stopped.endedAt ?? stopped.startedAt) - Date.parse(stopped.startedAt));
  const entries = store.readTimeline(stopped.id).length;
  const lines = [
    `Stopped session ${stopped.id} "${stopped.label}" after ${duration} (${plural(stopped.pulls.count, "pull")}).${pull.ok ? "" : ` The last pull failed: ${pull.problem}`}`,
    `Timeline: ${plural(entries, "entry", "entries")}, ${plural(metrics.marks, "mark")}, ${
      metrics.hangs.label === "missing" ? `hangs: ${metrics.hangs.reason}` : `${plural(metrics.hangs.value ?? 0, "hang")} of ${ctx.config.rules.hangs.minMs} ms or more`
    }, ${metrics.errorMessages.label === "missing" ? "error messages: missing" : plural(metrics.errorMessages.value?.length ?? 0, "different error message")}, peak memory ${describe(metrics.peakMemoryBytes, formatBytes)}.`,
    crashLine(newCrashLogs, copyFailures),
    `Files: ${store.dir(stopped.id)}`,
  ];
  return { summary: lines.join("\n"), data: { session: stopped.id, status: "stopped", dir: store.dir(stopped.id), newCrashLogs, copyFailures } };
}

function crashLine(crashes: Labeled<string[]>, copyFailures: string[]): string {
  if (crashes.label === "missing") return `Crashes: missing — ${crashes.reason}`;
  const names = crashes.value ?? [];
  if (names.length === 0) return "Crashes: no new crash log of this app (measured).";
  const failed = copyFailures.length > 0 ? ` ${copyFailures.join("; ")}.` : "";
  return `Crashes: ${plural(names.length, "new crash log")} (measured): ${names.join(", ")}.${failed}`;
}

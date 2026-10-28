/**
 * mark and snapshot.
 *
 * mark sends a mark command to the app and takes a real screenshot at the same moment
 * (devicectl capture screenshot on a phone, simctl io screenshot on a simulator,
 * screencapture -l on the Mac, which needs the window number from the app's snapshot).
 * snapshot asks the app for a snapshot on demand.
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import { findMailboxRoot } from "../devices/mailboxFolder.ts";
import { DeviceChoiceError, resolveDevice } from "../devices/registry.ts";
import { missing, type Labeled } from "../labels.ts";
import { attachCapture, capturePath, findMarkByCommand, isSafeName, readMarkFile } from "../session/ingest.ts";
import { findOutboxItem } from "../session/outbox.ts";
import { Recorder } from "../session/recorder.ts";
import { SessionStore } from "../session/store.ts";
import { markTitle } from "../session/text.ts";
import { latestWindowNumber } from "../session/windows.ts";
import { writeJsonAtomic } from "../fsx.ts";
import { ToolError, type ToolAnswer } from "./common.ts";

/** How many times (one second apart) to copy the mailbox while waiting for the app's answer. */
export const ANSWER_TRIES = 6;

export const SNAPSHOT_PARTS = ["tree", "ax", "state", "rendered", "screen"] as const;
export type SnapshotPart = (typeof SNAPSHOT_PARTS)[number];

/** The recorder of a session that is still recording; reopened if an earlier server started it. */
export async function activeRecorder(ctx: Context, sessionId: string): Promise<Recorder> {
  const store = new SessionStore(ctx.home);
  const session = store.read(sessionId);
  if (session.status === "stopped") throw new ToolError(`Session ${session.id} is stopped. Start a new session first.`);
  const existing = ctx.recorders.get(session.id);
  if (existing) return existing;
  try {
    const device = await resolveDevice(ctx, session.target, session.device.id);
    const recorder = new Recorder(ctx, store, device, session);
    ctx.recorders.set(session.id, recorder);
    if (ctx.autoPull) recorder.startTimer();
    return recorder;
  } catch (error) {
    if (error instanceof DeviceChoiceError) throw new ToolError(`Cannot reach the device of ${session.id}: ${error.message}`);
    throw error;
  }
}

/** Takes a real screenshot for a command and leaves it where ingest files it. */
async function capture(ctx: Context, recorder: Recorder, commandId: string): Promise<Labeled<string>> {
  const file = capturePath(recorder.dir, commandId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const root = findMailboxRoot(path.join(recorder.dir, "raw", "pull"));
  const windowNumber = recorder.device.target === "mac" && root ? latestWindowNumber(root) : undefined;
  const shot = await recorder.device.captureScreen(file, windowNumber);
  if (shot.label === "captured") {
    writeJsonAtomic(`${file.slice(0, -4)}.json`, { source: shot.source, at: ctx.now().toISOString() });
  }
  return shot;
}

/** Copies the mailbox until `done` says the answer is in, at most ANSWER_TRIES times. */
async function waitFor<T>(ctx: Context, recorder: Recorder, done: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < ANSWER_TRIES; attempt++) {
    await recorder.pullOnce();
    const answer = done();
    if (answer !== undefined) return answer;
    await ctx.sleep(1_000);
  }
  return undefined;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function captureText(shot: Labeled<string>): string {
  return shot.label === "captured" ? `screen captured (${shot.source})` : `no real capture (${shot.reason})`;
}

export interface MarkData {
  filed: boolean;
  commandId: string | null;
  mark: { n: number; dir: string } | null;
  capture: Labeled<string>;
}

export async function markTool(ctx: Context, input: { session: string; name?: string }): Promise<ToolAnswer<MarkData>> {
  const recorder = await activeRecorder(ctx, input.session);
  const { command, sent } = await recorder.sendCommand("mark", { name: input.name, ask: false });
  if (sent.label === "missing") {
    return {
      summary: `The mark command could not be sent: ${sent.reason}. Nothing was marked.`,
      data: { filed: false, commandId: null, mark: null, capture: missing("nothing was sent") },
    };
  }
  const isMac = recorder.device.target === "mac";
  let shot = isMac ? missing<string>("taken after the app's snapshot") : await capture(ctx, recorder, command.id);
  const filed = await waitFor(ctx, recorder, () => findMarkByCommand(recorder.ingestState, command.id));
  if (isMac && filed) shot = await capture(ctx, recorder, command.id);
  if (!filed) {
    const kept = shot.label === "captured" ? `The screen was captured (raw/captures/${command.id}.png); the mark will be filed with it if the app answers later.` : `No real capture: ${shot.reason}.`;
    return {
      summary: `The app did not answer within ${ANSWER_TRIES} s, so no mark is filed yet. ${kept}`,
      data: { filed: false, commandId: command.id, mark: null, capture: shot },
    };
  }
  attachCapture(recorder.dir, recorder.ingestState, command.id);
  const markFile = readMarkFile(path.join(recorder.dir, filed.dir));
  const summary = `${capitalized(markTitle(markFile))} is filed in ${filed.dir}: ${markPieces(markFile, shot).join(", ")}.`;
  return { summary, data: { filed: true, commandId: command.id, mark: { n: filed.n, dir: filed.dir }, capture: shot } };
}

function markPieces(markFile: ReturnType<typeof readMarkFile>, shot: Labeled<string>): string[] {
  const snapshot = markFile.snapshot;
  return [
    captureText(shot),
    snapshot ? `tree ${snapshot.nodes ?? "?"} nodes (measured)` : "the snapshot is not copied yet",
    snapshot && snapshot.axNodes !== null ? `accessibility ${snapshot.axNodes} nodes (measured)` : undefined,
    markFile.parts.state.label === "reported" ? "app state (reported)" : undefined,
    markFile.parts.screenRendered.label === "rendered" ? "rendered screen (rendered)" : undefined,
  ].filter((piece): piece is string => piece !== undefined);
}

export interface SnapshotData {
  snapshotId: string | null;
  dir: string | null;
  commandId: string;
  capture: Labeled<string>;
}

export async function snapshotTool(ctx: Context, input: { session: string; parts?: SnapshotPart[] }): Promise<ToolAnswer<SnapshotData>> {
  const recorder = await activeRecorder(ctx, input.session);
  const appParts = input.parts?.filter((part): part is Exclude<SnapshotPart, "screen"> => part !== "screen");
  const wantScreen = !input.parts || input.parts.includes("screen");
  const { command, sent } = await recorder.sendCommand("snapshot", appParts ? { parts: appParts } : {});
  if (sent.label === "missing") throw new ToolError(`The snapshot command could not be sent: ${sent.reason}`);
  const isMac = recorder.device.target === "mac";
  let shot = wantScreen && !isMac ? await capture(ctx, recorder, command.id) : missing<string>(wantScreen ? "taken after the app's snapshot" : "not asked for");
  const snapshotId = await waitFor(ctx, recorder, () => {
    const root = findMailboxRoot(path.join(recorder.dir, "raw", "pull"));
    const item = root ? findOutboxItem(root, command.id) : undefined;
    const id = item?.snapshotId;
    return isSafeName(id) && fs.existsSync(path.join(recorder.dir, "snapshots", id, "snapshot.json")) ? id : undefined;
  });
  if (!snapshotId) {
    return {
      summary: `The app did not answer within ${ANSWER_TRIES} s; no snapshot was filed. Is the app in the foreground?`,
      data: { snapshotId: null, dir: null, commandId: command.id, capture: shot },
    };
  }
  if (wantScreen && isMac) shot = await capture(ctx, recorder, command.id);
  const folder = path.join(recorder.dir, "snapshots", snapshotId);
  const captureFile = capturePath(recorder.dir, command.id);
  if (shot.label === "captured" && fs.existsSync(captureFile)) fs.copyFileSync(captureFile, path.join(folder, "screen-captured.png"));
  return { summary: snapshotSummary(snapshotId, folder, shot, wantScreen), data: { snapshotId, dir: `snapshots/${snapshotId}`, commandId: command.id, capture: shot } };
}

function snapshotSummary(id: string, folder: string, shot: Labeled<string>, wantScreen: boolean): string {
  const info = JSON.parse(fs.readFileSync(path.join(folder, "snapshot.json"), "utf8")) as {
    ms: number;
    tree?: { nodes: number } | null;
    ax?: { nodes: number } | null;
  };
  const has = (file: string) => fs.existsSync(path.join(folder, file));
  const parts = [
    has("tree.json") ? `tree ${info.tree?.nodes ?? "?"} nodes (measured)` : undefined,
    has("ax.json") ? `accessibility ${info.ax?.nodes ?? "?"} nodes (measured)` : undefined,
    has("state.json") ? "app state (reported)" : undefined,
    has("screen-rendered.png") ? "rendered screen (rendered)" : undefined,
    wantScreen ? (shot.label === "captured" ? "real screen (captured)" : `real screen missing: ${shot.reason}`) : undefined,
  ].filter(Boolean);
  return `Snapshot ${id} in snapshots/${id}: ${parts.join(", ")}. It took ${info.ms} ms in the app.`;
}

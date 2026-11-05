/**
 * Recording under awkward timing: a server restart, calls that overlap a stop, a relaunch that
 * fails, two sessions on one app, and crash logs that only look like this app's.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext } from "../src/context.ts";
import { crashTime } from "../src/session/recorder.ts";
import { markTool, snapshotTool } from "../src/tools/mark.ts";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { BUNDLE, MAC_BUNDLE, PHONE_ID, PNG } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

const START = { target: "phone" as const, device: PHONE_ID, bundleId: BUNDLE, label: "robust" };

function timeline(dir: string): any[] {
  return fs.readFileSync(path.join(dir, "timeline.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a command id that this session did not send is not trusted as a capture reference", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  const dir = sessionDir(ctx, id);
  fs.mkdirSync(path.join(dir, "raw/captures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "raw/captures/other-session-3.png"), PNG);
  kit.event("mark", { id: "x-m1", number: 1, name: null, source: "command", snapshotId: "none", commandId: "other-session-3" });
  await ctx.recorders.get(id)?.pullOnce();
  const mark = JSON.parse(fs.readFileSync(path.join(dir, "marks/1-command/mark.json"), "utf8"));
  assert.equal(mark.commandId, null);
  assert.equal(mark.parts.screenCaptured.label, "missing");
});

test("after a server restart, overlapping calls share one recorder", async () => {
  const first = setup();
  const kit = kitOn(first.world, first.clock).launch();
  const { data } = await sessionStart(first.ctx, START);
  const id = data.session!.id;
  first.world.onNotify = () => kit.respond("notification");
  const restarted = createContext({
    exec: first.world.exec,
    home: first.ctx.home,
    macHome: first.world.macHome,
    hostName: "Test Mac",
    now: first.clock.now,
    sleep: async (ms) => first.clock.advance(ms),
    autoPull: false,
  });
  await Promise.all([snapshotTool(restarted, { session: id, parts: ["state"] }), markTool(restarted, { session: id, name: "two" })]);
  assert.equal(restarted.recorders.size, 1);
  const commands = fs.readdirSync(path.join(sessionDir(first.ctx, id), "raw/commands")).filter((name) => !name.includes("ack"));
  assert.deepEqual(commands.sort(), ["000001-snapshot.json", "000002-mark.json"]);
});

test("calls that overlap a stop do not reopen the session, and a second stop does not repeat it", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  const recorder = ctx.recorders.get(id);
  world.phone().crashLogs.set("Sparrowpad-2026-11-04-101530.ips", "{}");
  const stoppingA = sessionStop(ctx, { session: id });
  const stoppingB = sessionStop(ctx, { session: id });
  await new Promise((resolve) => setImmediate(resolve)); // both stops have reached the recorder
  const late = await recorder?.pullOnce();
  const [stopA, stopB] = await Promise.all([stoppingA, stoppingB]);
  assert.match(stopA.summary, /^Stopped/);
  assert.match(stopB.summary, /^Stopped|already stopped/);
  assert.equal(late?.ok, false);
  const session = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx, id), "session.json"), "utf8"));
  assert.equal(session.status, "stopped");
  assert.equal(timeline(sessionDir(ctx, id)).filter((entry) => entry.kind === "crash").length, 1);
});

/** A crash report as the system writes it: a JSON header line, then the report as one JSON object. */
function crashReport(written: string, captured?: string): string {
  const header = JSON.stringify({ app_name: "Sparrowpad", timestamp: written, bundleID: BUNDLE, bug_type: "309" });
  return `${header}\n${JSON.stringify(captured ? { captureTime: captured, procName: "Sparrowpad" } : { procName: "Sparrowpad" })}`;
}

test("after a fatal error in the console, stop waits for a crash report that arrives late", async () => {
  const { ctx, world, clock, duringSleep } = setup();
  kitOn(world, clock).launch();
  world.consoleLines = ["Sparrowpad: launched\n", "Sparrowpad/TestTools.swift:51: Fatal ", "error: test crash\n"];
  const { data } = await sessionStart(ctx, { ...START, relaunch: true });
  const id = data.session!.id;
  const stopAt = clock.now().getTime();
  duringSleep.push(() => {
    if (clock.now().getTime() - stopAt >= 18_000) {
      world.phone().crashLogs.set("Sparrowpad-2026-11-04-101512.ips", crashReport("2026-11-04 11:15:12.00 +0100", "2026-11-04 11:15:06.8805 +0100"));
    }
  });
  const { summary } = await sessionStop(ctx, { session: id });
  assert.match(summary, /Crashes: 1 new crash log \(measured\): Sparrowpad-2026-11-04-101512\.ips\./);
  const crash = timeline(sessionDir(ctx, id)).find((entry) => entry.kind === "crash");
  assert.equal(crash?.at, "2026-11-04T10:15:06.880Z", "the crash is timed by the report's capture time, not by when it was written or picked up");
});

test("crash time: the capture time, else when the report was written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-time-"));
  const write = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  assert.equal(crashTime(write("a.ips", crashReport("2026-11-05 10:20:09.00 +0100", "2026-11-05 10:20:03.8805 +0100"))), "2026-11-05T09:20:03.880Z");
  assert.equal(crashTime(write("b.ips", crashReport("2026-11-05 10:20:09.00 +0100"))), "2026-11-05T09:20:09.000Z");
  assert.equal(crashTime(write("c.ips", "not a report")), undefined);
});

test("without a sign of a crash, stop does not wait, and says when it looked", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const before = clock.now().getTime();
  const { summary } = await sessionStop(ctx, { session: data.session!.id });
  assert.equal(clock.now().getTime(), before);
  assert.match(summary, /Crashes: no new crash log of this app when the session stopped \(measured\)\./);
});

test("a fatal error with no crash report says that Fieldbook waited, and how long", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  world.consoleLines = ["Terminating app due to uncaught exception 'NSRangeException'\n"];
  const { data } = await sessionStart(ctx, { ...START, relaunch: true });
  const before = clock.now().getTime();
  const { summary } = await sessionStop(ctx, { session: data.session!.id });
  assert.ok(clock.now().getTime() - before >= 45_000);
  assert.match(summary, /no new crash log of this app \(measured\), although the console showed a fatal error; Fieldbook waited 45 s for one\./);
});

test("a relaunch that fails is reported as failed, and its error output is kept", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  world.launchFails = true;
  const { data, summary } = await sessionStart(ctx, { ...START, relaunch: true });
  assert.match(summary, /The app was NOT relaunched/);
  assert.match(summary, /could not be launched/);
  const id = data.session!.id;
  const session = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx, id), "session.json"), "utf8"));
  assert.equal(session.relaunched, false);
  await sessionStop(ctx, { session: id });
  assert.match(fs.readFileSync(path.join(sessionDir(ctx, id), "console.log"), "utf8"), /could not be launched/);
});

test("a second session on the same device and app is refused while the first records", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const first = await sessionStart(ctx, START);
  const second = await sessionStart(ctx, { ...START, label: "again" });
  assert.equal(second.data.started, false);
  assert.match(second.summary, new RegExp(`${first.data.session!.id} is already recording`));
});

test("crash logs count only with this app's exact name pattern and bundle id", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  const header = (bundleID: string) => `${JSON.stringify({ app_name: "Sparrowpad", bundleID, timestamp: "2026-11-04 10:15:30.00 +0000" })}\n{"rest":1}`;
  world.phone().crashLogs.set("Sparrowpad-2026-11-04-101530.ips", header(BUNDLE));
  world.phone().crashLogs.set("Sparrowpad-2026-11-04-101531.ips", header("com.example.other"));
  world.phone().crashLogs.set("Sparrowpad-Helper-2026-11-04-101532.ips", header(BUNDLE));
  world.phone().crashLogs.set("Sparrowpad-notes.ips", header(BUNDLE));
  const answer = await sessionStop(ctx, { session: id });
  assert.deepEqual(fs.readdirSync(path.join(sessionDir(ctx, id), "crashes")), ["Sparrowpad-2026-11-04-101530.ips"]);
  assert.match(answer.summary, /1 new crash log/);
});

test("on the Mac, the capture uses the window number of this mark's own snapshot", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock, "this-mac").launch();
  const { data } = await sessionStart(ctx, { target: "mac", bundleId: MAC_BUNDLE, label: "window" });
  const id = data.session!.id;
  const stale = path.join(world.mailbox("this-mac"), "snapshots", "ffffffff-0099");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "snapshot.json"), JSON.stringify({ formatVersion: 1, id: "ffffffff-0099", time: "2030-01-01T00:00:00.000Z", reason: "command", ms: 1, parts: ["tree"], problems: [] }));
  fs.writeFileSync(path.join(stale, "tree.json"), JSON.stringify({ formatVersion: 1, limit: 5000, nodes: 1, truncated: false, windows: [{ index: 0, number: 7777, isKey: true, frame: { x: 0, y: 0, w: 1, h: 1 }, root: { type: "NSView", frame: { x: 0, y: 0, w: 1, h: 1 }, window: 0, hidden: false, alpha: 1, interactive: true, children: [] } }] }));
  world.onNotify = (device) => {
    if (device === "this-mac") kit.respond("notification");
  };
  await markTool(ctx, { session: id, name: "own window" });
  const captures = world.commandLines().filter((line) => line.startsWith("screencapture"));
  assert.ok(captures.some((line) => line.includes(" -l 4242 ")), captures.join("\n"));
  assert.ok(!captures.some((line) => line.includes(" -l 7777 ")));
});

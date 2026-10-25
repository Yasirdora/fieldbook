/**
 * session_start, the pull loop and session_stop, on the fake world with a fake kit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { BUNDLE, MAC_BUNDLE, PAD_ID, PHONE_ID, SIM_ID } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

const START = { target: "phone" as const, device: PHONE_ID, bundleId: BUNDLE, label: "before fix", build: "a1b2c3d", change: "IL-0210" };

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function timeline(dir: string): any[] {
  const file = path.join(dir, "timeline.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a locked phone: 'Unlock the phone', and nothing starts", async () => {
  const { ctx, world } = setup();
  world.phone().locked = true;
  const answer = await sessionStart(ctx, START);
  assert.match(answer.summary, /^Unlock the phone/);
  assert.equal(fs.existsSync(path.join(ctx.home, "sessions")), false);
  assert.ok(!world.commandLines().some((line) => /copy from|process launch/.test(line)));
  assert.equal(ctx.recorders.size, 0);
});

test("an unreachable phone: says so, and nothing starts", async () => {
  const { ctx } = setup();
  const answer = await sessionStart(ctx, { ...START, device: PAD_ID });
  assert.match(answer.summary, /not reachable/);
  assert.equal(ctx.recorders.size, 0);
});

test("start records the device, the app and hello.json, and stores build and change as given", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const answer = await sessionStart(ctx, START);
  const id = answer.data.session!.id;
  assert.match(id, /^20261104-101500-before-fix-[0-9a-f]{4}$/);
  const session = readJson(path.join(sessionDir(ctx, id), "session.json"));
  assert.equal(session.formatVersion, 1);
  assert.equal(session.status, "recording");
  assert.equal(session.build, "a1b2c3d");
  assert.equal(session.change, "IL-0210");
  assert.deepEqual(session.device.model, { label: "measured", value: "iPhone13,3", source: "devicectl list devices" });
  assert.equal(session.app.version.label, "measured");
  assert.equal(session.app.version.value, "1.0");
  assert.equal(session.app.commit.label, "reported");
  assert.equal(session.app.commit.value, "a1b2c3d");
  assert.equal(session.hello.runId, "5C1E0A2B-7D4F-4B8A-9E61-0F3D2C1B0A99");
  assert.equal(session.relaunched, false);
  assert.ok(!world.commandLines().some((line) => line.includes("process launch")));
  assert.doesNotMatch(answer.summary, /was relaunched/);
  assert.match(answer.summary, /not relaunched/);
});

test("relaunch only when asked: then the console is recorded and the summary says so", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const answer = await sessionStart(ctx, { ...START, relaunch: true });
  const launch = world.commandLines().find((line) => line.includes("process launch"));
  assert.ok(launch);
  assert.match(launch, /--terminate-existing/);
  assert.match(launch, /--console/);
  assert.doesNotMatch(launch, /--start-stopped/);
  assert.match(answer.summary, /The app was relaunched/);
  const id = answer.data.session!.id;
  await sessionStop(ctx, { session: id });
  const consoleLog = fs.readFileSync(path.join(sessionDir(ctx, id), "console.log"), "utf8");
  assert.match(consoleLog, /list shows 3 notes/);
});

test("full text needs a relaunch with -FieldbookText full", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const refused = await sessionStart(ctx, { ...START, fullText: true });
  assert.match(refused.summary, /needs relaunch: true/);
  assert.equal(ctx.recorders.size, 0);
  await sessionStart(ctx, { ...START, fullText: true, relaunch: true });
  assert.ok(world.commandLines().some((line) => line.endsWith("-- -FieldbookText full")));
});

test("pulling files events into the timeline, files marks, and acknowledges the outbox", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  const dir = sessionDir(ctx, id);
  clock.advance(2_000);
  kit.log("info", "Loaded 3 notes");
  kit.log("error", "Could not open note 42 after 3 tries", "store");
  clock.advance(3_000);
  kit.hang(412);
  kit.memory(52_428_800, 104_857_600);
  clock.advance(7_000);
  const markId = kit.shake();
  clock.advance(5_000);
  kit.note(markId, "The pin shows on page 2.");

  const recorder = ctx.recorders.get(id);
  assert.ok(recorder);
  await recorder.pullOnce();

  const entries = timeline(dir);
  const kinds = entries.map((entry) => entry.kind);
  for (const kind of ["launch", "lifecycle", "log", "hang", "memory", "mark", "note"]) assert.ok(kinds.includes(kind), kind);
  const mark = entries.find((entry) => entry.kind === "mark");
  assert.equal(mark.mark.n, 1);
  assert.equal(mark.mark.dir, "marks/1-shake");
  assert.equal(mark.label, "measured");
  assert.ok(mark.ms >= 11_000 && mark.ms <= 13_000, String(mark.ms));
  const note = entries.find((entry) => entry.kind === "note");
  assert.equal(note.label, "reported");

  const markDir = path.join(dir, "marks/1-shake");
  for (const file of ["mark.json", "tree.json", "ax.json", "state.json", "screen-rendered.png", "note.txt"]) {
    assert.ok(fs.existsSync(path.join(markDir, file)), file);
  }
  const markJson = readJson(path.join(markDir, "mark.json"));
  assert.equal(markJson.parts.screenRendered.label, "rendered");
  assert.equal(markJson.parts.state.label, "reported");
  assert.equal(markJson.parts.screenCaptured.label, "missing");
  assert.equal(fs.readFileSync(path.join(markDir, "note.txt"), "utf8"), "The pin shows on page 2.\n");

  // The outbox item was copied, so the server sent an ack; the kit then prunes it.
  assert.deepEqual(kit.inboxNames(), ["000001-ack.json"]);
  kit.respond("notification");
  assert.deepEqual(kit.outboxNames(), []);

  // A second pull adds nothing twice.
  const before = timeline(dir).length;
  await recorder.pullOnce();
  assert.equal(timeline(dir).length, before + 1, "only the ack's command event is new");
});

test("events from before the session started are left out", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock);
  kit.launch();
  kit.log("error", "an old error from before the session");
  clock.advance(60_000);
  const { data } = await sessionStart(ctx, START);
  const entries = timeline(sessionDir(ctx, data.session!.id));
  assert.equal(entries.filter((entry) => entry.kind === "log").length, 0);
});

test("both copy layouts of devicectl copy from work", async () => {
  const { ctx, world, clock } = setup();
  world.copyLayout = "contents";
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  clock.advance(1_000);
  kit.hang(300);
  await ctx.recorders.get(data.session!.id)?.pullOnce();
  assert.ok(timeline(sessionDir(ctx, data.session!.id)).some((entry) => entry.kind === "hang"));
});

test("stop: a last pull, new crash logs of this app only, and the bundle is closed", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  clock.advance(4_000);
  kit.hang(500);
  world.phone().crashLogs.set("Sparrowpad-2026-11-04-101504.ips", "{\"crash\":true}");
  world.phone().crashLogs.set("OtherApp-2026-11-04-101504.ips", "{\"other\":true}");
  clock.advance(60_000);
  const answer = await sessionStop(ctx, { session: id });
  const dir = sessionDir(ctx, id);
  assert.deepEqual(fs.readdirSync(path.join(dir, "crashes")), ["Sparrowpad-2026-11-04-101504.ips"]);
  const session = readJson(path.join(dir, "session.json"));
  assert.equal(session.status, "stopped");
  assert.ok(session.endedAt);
  const entries = timeline(dir);
  assert.ok(entries.some((entry) => entry.kind === "hang"), "the last pull happened");
  assert.ok(entries.some((entry) => entry.kind === "crash"));
  assert.match(answer.summary, /1 new crash log/);
  assert.equal(ctx.recorders.has(id), false);
  const again = await sessionStop(ctx, { session: id });
  assert.match(again.summary, /already stopped/);
});

test("a simulator session reads the container found by get_app_container", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock, SIM_ID).launch();
  const { data, summary } = await sessionStart(ctx, { target: "simulator", device: SIM_ID, bundleId: BUNDLE, label: "sim run" });
  assert.match(summary, /simulator "Scratch iPhone"/);
  clock.advance(1_000);
  kit.hang(260);
  await ctx.recorders.get(data.session!.id)?.pullOnce();
  assert.ok(timeline(sessionDir(ctx, data.session!.id)).some((entry) => entry.kind === "hang"));
  assert.ok(world.commandLines().some((line) => line.includes(`get_app_container ${SIM_ID} ${BUNDLE} data`)));
});

test("a Mac session reads the sandboxed app's container directly", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock, "this-mac").launch();
  const { data } = await sessionStart(ctx, { target: "mac", bundleId: MAC_BUNDLE, label: "mac run" });
  clock.advance(1_000);
  kit.log("error", "mac error");
  await ctx.recorders.get(data.session!.id)?.pullOnce();
  assert.ok(timeline(sessionDir(ctx, data.session!.id)).some((entry) => entry.kind === "log"));
});

test("relaunch is refused on the Mac with the reason", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock, "this-mac").launch();
  const answer = await sessionStart(ctx, { target: "mac", bundleId: MAC_BUNDLE, label: "mac", relaunch: true });
  assert.match(answer.summary, /cannot relaunch a Mac app/);
  assert.equal(ctx.recorders.size, 0);
});

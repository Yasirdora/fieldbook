/**
 * The phone's clock and the Mac's clock may differ. Only what was already in the mailbox when the
 * session started is judged by its time; what arrives later is new by its sequence number.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sessionStart } from "../src/tools/session.ts";
import { FakeKit } from "./fakes/kit.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { sessionDir, setup } from "./testContext.ts";

const START = { target: "phone" as const, device: PHONE_ID, bundleId: BUNDLE, label: "skew" };

function timeline(dir: string): any[] {
  const file = path.join(dir, "timeline.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A kit whose clock runs `offsetMs` behind (negative) or ahead of the Mac's. */
function skewedKit(s: ReturnType<typeof setup>, offsetMs: number, runId?: string): FakeKit {
  return new FakeKit(s.world.mailbox(PHONE_ID), { bundleId: BUNDLE, runId, now: () => new Date(s.clock.now().getTime() + offsetMs) });
}

test("a phone clock 5 s behind the Mac loses nothing that happens after the session started", async () => {
  const s = setup();
  const kit = skewedKit(s, -5_000).launch();
  kit.log("error", "an old error from before the session");
  s.clock.advance(60_000);
  const { data } = await sessionStart(s.ctx, START);
  const dir = sessionDir(s.ctx, data.session!.id);
  s.clock.advance(1_000);
  kit.hang(412);
  kit.shake();
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();

  const kinds = timeline(dir).map((entry) => entry.kind);
  assert.ok(kinds.includes("hang"), `a hang after the start is kept: ${kinds.join(", ")}`);
  assert.ok(kinds.includes("mark"), `a mark after the start is kept: ${kinds.join(", ")}`);
  assert.ok(fs.existsSync(path.join(dir, "marks/1-shake/ax.json")), "the mark's snapshot is copied");
  assert.ok(!timeline(dir).some((entry) => entry.kind === "log" && /old error/.test(entry.log.message)), "what was there before the start stays out");
});

test("with a clock behind, an outbox item from after the start is acknowledged only once its files are in the session", async () => {
  const s = setup();
  const kit = skewedKit(s, -5_000).launch();
  s.clock.advance(60_000);
  const { data } = await sessionStart(s.ctx, START);
  const dir = sessionDir(s.ctx, data.session!.id);
  s.clock.advance(1_000);
  kit.shake();
  // The kit has not written the snapshot yet: the item names files the copy does not have.
  const snapshots = path.join(s.world.mailbox(PHONE_ID), "snapshots");
  const hidden = `${snapshots}.later`;
  fs.renameSync(snapshots, hidden);
  fs.mkdirSync(snapshots);
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();
  assert.deepEqual(kit.inboxNames(), [], "no ack while the mark's snapshot is missing");
  fs.rmSync(snapshots, { recursive: true });
  fs.renameSync(hidden, snapshots);
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();
  assert.ok(fs.existsSync(path.join(dir, "marks/1-shake/ax.json")), "the snapshot arrived and was copied");
  assert.deepEqual(kit.inboxNames(), ["000001-ack.json"]);
});

test("after a relaunch, the new run's first events count even with the phone's clock behind", async () => {
  const s = setup();
  skewedKit(s, -5_000).launch();
  s.clock.advance(60_000);
  // The fake device starts this run when Fieldbook relaunches the app.
  s.world.onLaunch = () => skewedKit(s, -5_000, "7A1B2C3D-0000-4000-8000-000000000001").launch(250);
  const { data } = await sessionStart(s.ctx, { ...START, relaunch: true });
  const launches = timeline(sessionDir(s.ctx, data.session!.id)).filter((entry) => entry.kind === "launch");
  assert.deepEqual(launches.map((entry) => entry.launch.ms), [250]);
});

test("with a clock behind, a log the kit reads late is judged by the phone's own clock", async () => {
  const s = setup();
  const kit = skewedKit(s, -5_000).launch();
  s.clock.advance(60_000);
  // The kit writes a memory sample every 2 s while the app runs; this is the newest before the start.
  kit.memory(52_428_800, 52_428_800);
  const { data } = await sessionStart(s.ctx, START);
  s.clock.advance(1_000);
  const phoneNow = s.clock.now().getTime() - 5_000;
  const late = (message: string, agoMs: number) =>
    kit.event("log", { level: "error", subsystem: BUNDLE, category: "late", message, cut: false, logTime: new Date(phoneNow - agoMs).toISOString() });
  late("logged half a minute before the session", 30_000);
  late("logged just after the session started", 500);
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();
  const logs = timeline(sessionDir(s.ctx, data.session!.id)).filter((entry) => entry.kind === "log").map((entry) => entry.log.message);
  assert.deepEqual(logs, ["logged just after the session started"]);
});

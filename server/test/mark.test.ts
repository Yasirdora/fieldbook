/**
 * mark and snapshot: a command to the app plus a real screenshot taken by the Mac.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { markTool, snapshotTool } from "../src/tools/mark.ts";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { BUNDLE, MAC_BUNDLE, PHONE_ID, SIM_ID } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

async function recording(device = PHONE_ID) {
  const s = setup();
  const kit = kitOn(s.world, s.clock, device).launch();
  const target = device === "this-mac" ? "mac" : device === SIM_ID ? "simulator" : "phone";
  const { data } = await sessionStart(s.ctx, {
    target,
    device: device === "this-mac" ? undefined : device,
    bundleId: device === "this-mac" ? MAC_BUNDLE : BUNDLE,
    label: "before fix",
  });
  const id = data.session!.id;
  return { ...s, kit, id, dir: sessionDir(s.ctx, id) };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("mark on a phone: the app files a snapshot, the Mac adds a real capture", async () => {
  const { ctx, world, kit, id, dir, clock } = await recording();
  world.onNotify = (_device, name) => {
    if (name.endsWith(".inbox")) kit.respond("notification");
  };
  clock.advance(12_400);
  const answer = await markTool(ctx, { session: id, name: "pin on the wrong page" });
  assert.match(answer.summary, /^Mark 1 "pin on the wrong page" is filed in marks\/1-pin-on-the-wrong-page/);
  assert.match(answer.summary, /screen captured/);
  const markDir = path.join(dir, "marks/1-pin-on-the-wrong-page");
  for (const file of ["mark.json", "tree.json", "ax.json", "state.json", "screen-rendered.png", "screen-captured.png"]) {
    assert.ok(fs.existsSync(path.join(markDir, file)), file);
  }
  const mark = readJson(path.join(markDir, "mark.json"));
  assert.equal(mark.parts.screenCaptured.label, "captured");
  assert.equal(mark.parts.screenCaptured.source, "devicectl capture screenshot");
  assert.equal(mark.parts.screenRendered.label, "rendered");
  assert.equal(mark.source, "command");
  const command = readJson(path.join(dir, "raw/commands/000001-mark.json"));
  assert.deepEqual(command.args, { ask: false, name: "pin on the wrong page" });
  assert.ok(world.commandLines().some((line) => line.includes("capture screenshot")));
});

test("mark when the app does not answer: the capture is kept and filed when the app answers later", async () => {
  const { ctx, kit, id, dir } = await recording();
  const answer = await markTool(ctx, { session: id, name: "late" });
  assert.match(answer.summary, /did not answer/);
  assert.match(answer.summary, /screen was captured/);
  assert.equal(fs.existsSync(path.join(dir, "marks")), false);
  kit.respond("poll");
  await ctx.recorders.get(id)?.pullOnce();
  const mark = readJson(path.join(dir, "marks/1-late/mark.json"));
  assert.equal(mark.parts.screenCaptured.label, "captured");
});

test("mark on a simulator uses simctl io screenshot", async () => {
  const { ctx, world, kit, id } = await recording(SIM_ID);
  world.onNotify = () => kit.respond("notification");
  const answer = await markTool(ctx, { session: id });
  assert.match(answer.summary, /^Mark 1 \(command\)/);
  assert.ok(world.commandLines().some((line) => line.includes(`io ${SIM_ID} screenshot`)));
});

test("mark on the Mac captures the app's window by the number in its snapshot", async () => {
  const { ctx, world, kit, id, dir } = await recording("this-mac");
  world.onNotify = (device) => {
    if (device === "this-mac") kit.respond("notification");
  };
  const answer = await markTool(ctx, { session: id, name: "toolbar" });
  assert.ok(world.commandLines().some((line) => /^screencapture -l 4242 /.test(line)));
  assert.match(answer.summary, /screen captured/);
  const mark = readJson(path.join(dir, "marks/1-toolbar/mark.json"));
  assert.equal(mark.parts.screenCaptured.label, "captured");
  assert.match(mark.parts.screenCaptured.source, /screencapture -l 4242/);
});

test("mark and snapshot refuse a stopped session", async () => {
  const { ctx, id } = await recording();
  await sessionStop(ctx, { session: id });
  await assert.rejects(markTool(ctx, { session: id }), /stopped/);
  await assert.rejects(snapshotTool(ctx, { session: id }), /stopped/);
});

test("snapshot on demand: files snapshots/<id>/ with a real capture", async () => {
  const { ctx, world, kit, id, dir } = await recording();
  world.onNotify = () => kit.respond("notification");
  const answer = await snapshotTool(ctx, { session: id });
  const snapshotId = answer.data.snapshotId;
  assert.ok(snapshotId);
  const folder = path.join(dir, "snapshots", snapshotId);
  for (const file of ["snapshot.json", "tree.json", "ax.json", "state.json", "screen-rendered.png", "screen-captured.png"]) {
    assert.ok(fs.existsSync(path.join(folder, file)), file);
  }
  assert.match(answer.summary, new RegExp(`^Snapshot ${snapshotId}`));
  assert.match(answer.summary, /tree 5 nodes \(measured\)/);
  assert.match(answer.summary, /app state \(reported\)/);
  assert.match(answer.summary, /real screen \(captured\)/);
});

test("snapshot with parts asks the app only for those, and skips the capture unless asked", async () => {
  const { ctx, world, kit, id, dir } = await recording();
  world.onNotify = () => kit.respond("notification");
  await snapshotTool(ctx, { session: id, parts: ["state"] });
  const command = readJson(path.join(dir, "raw/commands/000001-snapshot.json"));
  assert.deepEqual(command.args, { parts: ["state"] });
  assert.ok(!world.commandLines().some((line) => line.includes("capture screenshot")));
});

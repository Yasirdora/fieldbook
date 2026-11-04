/**
 * The kit-server contract, from the second kit review: the server must read what the kit
 * really writes, including its failures, and say so when it cannot.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FakeKit } from "./fakes/kit.ts";
import { findTool } from "../src/tools/find.ts";
import { snapshotTool } from "../src/tools/mark.ts";
import { sessionStart } from "../src/tools/session.ts";
import { timelineTool } from "../src/tools/timeline.ts";
import { BUNDLE, MAC_BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

const START = { target: "phone" as const, device: PHONE_ID, bundleId: BUNDLE, label: "contract" };

function timeline(dir: string): any[] {
  return fs.readFileSync(path.join(dir, "timeline.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a snapshot the app could not store is reported at once, with the app's reason", async () => {
  const { ctx, world, clock } = setup();
  const kit = new FakeKit(world.mailbox(PHONE_ID), { bundleId: BUNDLE, now: clock.now, failSnapshots: true }).launch();
  const { data } = await sessionStart(ctx, START);
  world.onNotify = () => kit.respond("notification");
  const pullsBefore = world.commandLines().filter((line) => line.includes("copy from")).length;
  const answer = await snapshotTool(ctx, { session: data.session!.id, parts: ["state"] });
  assert.match(answer.summary, /could not store the snapshot: The snapshot could not be stored\./);
  assert.doesNotMatch(answer.summary, /did not answer/);
  const pulls = world.commandLines().filter((line) => line.includes("copy from")).length - pullsBefore;
  assert.ok(pulls <= 2, `pulled ${pulls} times`);
});

test("a Mac snapshot of the screen only also asks the app for its tree (it holds the window number)", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock, "this-mac").launch();
  const { data } = await sessionStart(ctx, { target: "mac", bundleId: MAC_BUNDLE, label: "mac screen" });
  const id = data.session!.id;
  world.onNotify = () => kit.respond("notification");
  await snapshotTool(ctx, { session: id, parts: ["state", "screen"] });
  const command = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx, id), "raw/commands/000001-snapshot.json"), "utf8"));
  assert.deepEqual(command.args.parts.sort(), ["state", "tree"]);
  assert.ok(world.commandLines().some((line) => line.startsWith("screencapture -l 4242 ")));
});

test("event lines the server skips are reported once each, and a newer format says to update the server", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  const events = path.join(world.mailbox(PHONE_ID), "events.jsonl");
  const now = clock.now().toISOString();
  fs.appendFileSync(events, `${JSON.stringify({ formatVersion: 2, runId: kit.runId, seq: 90, time: now, kind: "hang", hang: { start: now, ms: 300 } })}\n`);
  fs.appendFileSync(events, `${JSON.stringify({ formatVersion: 1, runId: kit.runId, seq: 91, time: now, kind: "hang", hang: { start: now, ms: "long" } })}\n`);
  const recorder = ctx.recorders.get(id);
  await recorder?.pullOnce();
  await recorder?.pullOnce();
  const problems = timeline(sessionDir(ctx, id)).filter((entry) => entry.kind === "problem").map((entry) => entry.problem.message);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((message) => /format version 2.*Update the server/.test(message)));
  assert.ok(problems.some((message) => /fields do not match the format/.test(message)));
});

test("logs are kept or left out by when they were logged, not when the kit read them", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  clock.advance(5_000);
  kit.event("log", { level: "error", subsystem: BUNDLE, category: "old", message: "logged long before the session", cut: false, logTime: "2026-11-04T09:00:00.000Z" });
  kit.log("error", "logged during the session");
  await ctx.recorders.get(id)?.pullOnce();
  const logs = timeline(sessionDir(ctx, id)).filter((entry) => entry.kind === "log").map((entry) => entry.log.message);
  assert.deepEqual(logs, ["logged during the session"]);
});

test("an empty mark name counts as no name", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  kit.event("mark", { id: "x-m1", number: 1, name: "", source: "command", snapshotId: "none" });
  await ctx.recorders.get(id)?.pullOnce();
  const mark = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx, id), "marks/1-command/mark.json"), "utf8"));
  assert.equal(mark.name, null);
});

test("the text mode the app reports is shown, and full text that the app refuses is called out", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const answer = await sessionStart(ctx, { ...START, relaunch: true, fullText: true });
  assert.match(answer.summary, /the app reports hashed text/);
  const timelineAnswer = await timelineTool(ctx, { session: answer.data.session!.id });
  assert.match(timelineAnswer.summary, /text hashed \(reported by the app\)/);
});

test("type names match on their last part, with or without a module name", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, START);
  const id = data.session!.id;
  kit.shake();
  await ctx.recorders.get(id)?.pullOnce();
  for (const query of ["type:AccessibilityNode", "type:SwiftUI.AccessibilityNode"]) {
    const found = await findTool(ctx, { session: id, mark: "1", query });
    assert.equal(found.data.matches.length, 2, query);
  }
});

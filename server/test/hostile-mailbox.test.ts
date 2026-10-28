/**
 * Data copied from the device mailbox is untrusted: an app bug (or a broken file) could write
 * anything there. These tests write such data and check that nothing leaves the session
 * folder and that recording goes on.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { evidenceTool } from "../src/tools/evidence.ts";
import { snapshotTool } from "../src/tools/mark.ts";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { BUNDLE, PHONE_ID, PNG } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

async function recording() {
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "hostile" });
  const id = data.session!.id;
  return { ...s, kit, id, dir: sessionDir(s.ctx, id), mailbox: s.world.mailbox(PHONE_ID) };
}

function timeline(dir: string): any[] {
  return fs.readFileSync(path.join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a snapshotId with '..' from the outbox cannot make the snapshot tool write outside the session", async () => {
  const { ctx, world, mailbox, id } = await recording();
  const outside = path.join(ctx.home, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "snapshot.json"), "{}");
  world.onNotify = () => {
    const inbox = path.join(mailbox, "inbox");
    for (const name of fs.readdirSync(inbox)) {
      const command = JSON.parse(fs.readFileSync(path.join(inbox, name), "utf8"));
      fs.rmSync(path.join(inbox, name));
      const item = { formatVersion: 1, seq: 7, runId: "R", time: new Date().toISOString(), kind: "result", commandId: command.id, ok: true, snapshotId: "../../../outside" };
      fs.writeFileSync(path.join(mailbox, "outbox", "000007-result.json"), JSON.stringify(item));
    }
  };
  const answer = await snapshotTool(ctx, { session: id });
  assert.equal(answer.data.snapshotId, null);
  assert.equal(fs.existsSync(path.join(outside, "screen-captured.png")), false);
});

test("a commandId with '..' in a mark event cannot file a foreign picture as the captured screen", async () => {
  const { ctx, kit, id, dir } = await recording();
  fs.writeFileSync(path.join(ctx.home, "evil.png"), PNG);
  fs.writeFileSync(path.join(ctx.home, "evil.json"), "null");
  kit.event("mark", { id: "x-m1", number: 1, name: null, source: "shake", snapshotId: "nope", commandId: "../../../../evil" });
  await ctx.recorders.get(id)?.pullOnce();
  const mark = JSON.parse(fs.readFileSync(path.join(dir, "marks/1-shake/mark.json"), "utf8"));
  assert.equal(mark.parts.screenCaptured.label, "missing");
  assert.equal(fs.existsSync(path.join(dir, "marks/1-shake/screen-captured.png")), false);
});

test("a folder or a link inside a snapshot is skipped, and recording goes on", async () => {
  const { ctx, kit, id, dir, mailbox } = await recording();
  const markId = kit.shake();
  const snapshotDir = path.join(mailbox, "snapshots", fs.readdirSync(path.join(mailbox, "snapshots"))[0] as string);
  fs.mkdirSync(path.join(snapshotDir, "a-folder"));
  fs.symlinkSync("/etc/hostname", path.join(snapshotDir, "secret.txt"));
  kit.note(markId, "still recorded");
  await ctx.recorders.get(id)?.pullOnce();
  const files = fs.readdirSync(path.join(dir, "marks/1-shake"));
  assert.ok(files.includes("tree.json"));
  assert.ok(!files.includes("a-folder"));
  assert.ok(!files.includes("secret.txt"));
  assert.ok(timeline(dir).some((entry) => entry.kind === "note"));
  const stopped = await sessionStop(ctx, { session: id });
  assert.match(stopped.summary, /^Stopped/);
});

test("a note for a mark id like 'constructor' does not break the pull", async () => {
  const { ctx, kit, id, dir } = await recording();
  kit.note("constructor", "odd id");
  kit.note("__proto__", "odder id");
  kit.log("error", "after the odd notes");
  await ctx.recorders.get(id)?.pullOnce();
  const entries = timeline(dir);
  assert.equal(entries.filter((entry) => entry.kind === "note").length, 2);
  assert.ok(entries.some((entry) => entry.kind === "log"));
});

test("one broken event does not lose the events after it", async () => {
  const { ctx, kit, id, dir, mailbox } = await recording();
  fs.appendFileSync(
    path.join(mailbox, "events.jsonl"),
    `${JSON.stringify({ formatVersion: 1, runId: "5C1E0A2B-7D4F-4B8A-9E61-0F3D2C1B0A99", seq: 50, time: new Date().toISOString(), kind: "log", log: { level: "error", message: 42 } })}\n`,
  );
  kit.event("hang", { start: new Date().toISOString(), ms: 300 });
  await ctx.recorders.get(id)?.pullOnce();
  const entries = timeline(dir);
  assert.ok(entries.some((entry) => entry.kind === "hang"));
});

test("a stray file name in the outbox does not set the ack number", async () => {
  const { ctx, kit, id, dir, mailbox } = await recording();
  kit.shake();
  fs.writeFileSync(path.join(mailbox, "outbox", "20261104-notes.json"), "{}");
  await ctx.recorders.get(id)?.pullOnce();
  const ack = JSON.parse(fs.readFileSync(path.join(dir, "raw/commands/000001-ack.json"), "utf8"));
  assert.deepEqual(ack.args, { upTo: 1 });
});

test("evidence.json never carries the device id, the device name or the Mac's name", async () => {
  const { ctx, id, dir } = await recording();
  await sessionStop(ctx, { session: id });
  const sessionFile = path.join(dir, "session.json");
  const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  session.problems.push(`devicectl failed for ${PHONE_ID} ("Test iPhone") on Test Mac`);
  session.app.commit = { label: "missing", reason: `no commit on Test iPhone (${PHONE_ID})` };
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  await evidenceTool(ctx, { session: id });
  const text = fs.readFileSync(path.join(dir, "evidence.json"), "utf8");
  assert.doesNotMatch(text, new RegExp(PHONE_ID));
  assert.doesNotMatch(text, /Test iPhone/);
  assert.doesNotMatch(text, /Test Mac/);
});

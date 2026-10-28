/**
 * compare, evidence, find and timeline with incomplete or broken data:
 * a number that could not be had must never pass, and nothing may throw on a bad file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_RULES } from "../src/config.ts";
import { sessionMetrics } from "../src/session/metrics.ts";
import type { SessionFile, TimelineEntry } from "../src/session/store.ts";
import { compareTool } from "../src/tools/compare.ts";
import { evidenceTool } from "../src/tools/evidence.ts";
import { findTool } from "../src/tools/find.ts";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { timelineTool } from "../src/tools/timeline.ts";
import { BEFORE, record } from "./compareSetup.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

const ruleOf = (data: Awaited<ReturnType<typeof compareTool>>["data"], id: string) => data.rules.find((rule) => rule.id === id);

test("evidence refuses a comparison made while a session was recording, or of sessions that changed since", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const kit = kitOn(s.world, s.clock, PHONE_ID, "CCCCCCCC-0000-4000-8000-000000000003").launch(410);
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "still going" });
  const b = data.session!.id;
  const early = await compareTool(s.ctx, { a, b });
  await assert.rejects(evidenceTool(s.ctx, { comparison: early.data.id }), /still recording when compared/);
  s.clock.advance(1_000);
  kit.hang(700);
  await sessionStop(s.ctx, { session: b });
  const late = await compareTool(s.ctx, { a, b });
  await evidenceTool(s.ctx, { comparison: late.data.id });
  fs.appendFileSync(path.join(sessionDir(s.ctx, b), "timeline.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir(s.ctx, b), "timeline.jsonl"), "");
  await assert.rejects(evidenceTool(s.ctx, { comparison: late.data.id }), /changed after the comparison/);
});

test("numbers that are not finite are missing, never measured", () => {
  const session = { status: "stopped", pulls: { count: 3 }, crashes: { label: "measured", value: [] } } as unknown as SessionFile;
  const entry = (kind: string, payload: unknown): TimelineEntry => ({ at: "2026-11-04T10:15:01.000Z", ms: 1000, kind, label: "measured", [kind]: payload });
  const metrics = sessionMetrics(session, [entry("launch", { ms: Number.NaN }), entry("memory", { footprint: 1 }), entry("log", { level: "error", message: 42 })], DEFAULT_RULES);
  assert.equal(metrics.launchMedianMs.label, "missing");
  assert.equal(metrics.peakMemoryBytes.label, "missing");
  assert.deepEqual(metrics.errorMessages.value, []);
});

test("a mark whose snapshot is missing is unchecked, not passed", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const b = await record(s, "after", BEFORE, "BBBBBBBB-0000-4000-8000-000000000002");
  fs.rmSync(path.join(sessionDir(s.ctx, a), "marks/1-pin-on-the-wrong-page/tree.json"));
  fs.rmSync(path.join(sessionDir(s.ctx, a), "marks/1-pin-on-the-wrong-page/ax.json"));
  const { data, summary } = await compareTool(s.ctx, { a, b });
  assert.equal(data.marks[0]?.verdict, "unchecked");
  assert.match(summary, /unchecked +Mark "pin on the wrong page"/);
});

test("a broken tree makes only that mark unchecked; the rules and find still work", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const b = await record(s, "after", BEFORE, "BBBBBBBB-0000-4000-8000-000000000002");
  const treeFile = path.join(sessionDir(s.ctx, b), "marks/1-pin-on-the-wrong-page/tree.json");
  const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
  delete tree.windows[0].root.children[0].children;
  delete tree.windows[0].root.frame;
  fs.writeFileSync(treeFile, JSON.stringify(tree));
  const { data } = await compareTool(s.ctx, { a, b });
  assert.equal(data.rules.length, 5);
  const found = await findTool(s.ctx, { session: b, mark: "1", query: "id:pinnedBadge" });
  assert.deepEqual(found.data.matches.map((match) => match.source), ["ax"]);
});

test("newErrors is unchecked when b's mailbox was never copied, and so are hangs in the timeline header", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  fs.rmSync(s.world.mailbox(PHONE_ID), { recursive: true, force: true });
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "no mailbox" });
  const b = data.session!.id;
  await sessionStop(s.ctx, { session: b });
  const compared = await compareTool(s.ctx, { a, b });
  assert.equal(ruleOf(compared.data, "newErrors")?.verdict, "unchecked");
  assert.equal(ruleOf(compared.data, "hangs")?.verdict, "unchecked");
  const timeline = await timelineTool(s.ctx, { session: b });
  assert.match(timeline.summary, /hangs: the mailbox was never copied/);
  assert.doesNotMatch(timeline.summary, /0 hangs/);
});

test("a new crash log that cannot be copied still counts as a crash", async () => {
  const s = setup();
  kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "crash copy fails" });
  const id = data.session!.id;
  s.world.phone().crashLogs.set("Sparrowpad-2026-11-04-120000.ips", "{}");
  s.world.failingCopies.add("Sparrowpad-2026-11-04-120000.ips");
  const answer = await sessionStop(s.ctx, { session: id });
  assert.match(answer.summary, /1 new crash log/);
  assert.match(answer.summary, /could not be copied/);
  const session = JSON.parse(fs.readFileSync(path.join(sessionDir(s.ctx, id), "session.json"), "utf8"));
  assert.deepEqual(session.crashes.value, ["Sparrowpad-2026-11-04-120000.ips"]);
});

test("find on a mark without trees says so", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const markDir = path.join(sessionDir(s.ctx, a), "marks/1-pin-on-the-wrong-page");
  fs.rmSync(path.join(markDir, "tree.json"));
  fs.rmSync(path.join(markDir, "ax.json"));
  const { summary } = await findTool(s.ctx, { session: a, mark: "1", query: "id:pinnedBadge" });
  assert.match(summary, /has no view tree or accessibility tree/);
});

test("a blank mark or around is refused instead of picking an unnamed mark", async () => {
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "blank" });
  const id = data.session!.id;
  kit.shake();
  await s.ctx.recorders.get(id)?.pullOnce();
  await assert.rejects(timelineTool(s.ctx, { session: id, around: " " }), /give a mark number or name/);
  await assert.rejects(findTool(s.ctx, { session: id, mark: "", query: "id:x" }), /give a mark number or name/);
});

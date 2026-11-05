/**
 * compare: two sessions of the same steps, with clear pass and fail rules.
 * Each rule shows both numbers and pass, warn, fail or unchecked. Never one overall score.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareTool } from "../src/tools/compare.ts";
import { sessionStart } from "../src/tools/session.ts";
import { AFTER, BEFORE, record, twoSessions } from "./compareSetup.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, setup } from "./testContext.ts";

test("each rule shows both numbers and a verdict; there is no overall score", async () => {
  const { ctx, a, b } = await twoSessions();
  const { data, summary } = await compareTool(ctx, { a, b });
  const byId = Object.fromEntries(data.rules.map((rule) => [rule.id, rule]));
  assert.deepEqual(Object.keys(byId).sort(), ["crashes", "hangs", "launchMedian", "newErrors", "peakMemory"]);
  for (const rule of data.rules) {
    assert.ok(["pass", "warn", "fail", "unchecked"].includes(rule.verdict), rule.id);
    assert.ok("a" in rule && "b" in rule, rule.id);
  }
  assert.doesNotMatch(JSON.stringify(data), /"(score|overall)"/);
  assert.doesNotMatch(summary, /score\s*[:=]|\d+\s*\/\s*\d+\s*points|overall:/i, "no score is given");
});

test("the default rules: crash, launch and hangs fail; memory passes; new errors warn", async () => {
  const { ctx, a, b } = await twoSessions();
  const { data, summary } = await compareTool(ctx, { a, b });
  const rule = (id: string) => data.rules.find((candidate) => candidate.id === id);
  assert.equal(rule("crashes")?.verdict, "fail");
  assert.deepEqual([rule("crashes")?.a.value, rule("crashes")?.b.value], [0, 1]);
  assert.equal(rule("launchMedian")?.verdict, "fail");
  assert.deepEqual([rule("launchMedian")?.a.value, rule("launchMedian")?.b.value], [BEFORE.launchMs, AFTER.launchMs]);
  assert.equal(rule("peakMemory")?.verdict, "pass");
  assert.equal(rule("hangs")?.verdict, "fail");
  assert.deepEqual([rule("hangs")?.a.value, rule("hangs")?.b.value], [1, 3]);
  assert.equal(rule("newErrors")?.verdict, "warn");
  assert.deepEqual(rule("newErrors")?.b.value, ["Could not save note #"]);
  assert.match(summary, /fail +Launch time \(median\): a 400 ms, b 600 ms/);
  assert.match(summary, /Could not save note #/);
});

test("new error messages from Apple's frameworks are listed but never warn; only the app's own do", async () => {
  // Measured on an iPhone: 236 com.apple.* error and fault lines in 17 minutes of an unchanged app.
  const s = setup();
  const handler = "cannot add handler to 0 from 0 - dropping";
  const a = await record(s, "before", { ...BEFORE, systemErrors: [handler] }, "AAAAAAAA-0000-4000-8000-000000000001");
  const b = await record(s, "after", { ...BEFORE, systemErrors: [handler, "Unable to simultaneously satisfy constraints."] }, "BBBBBBBB-0000-4000-8000-000000000002");
  const { data, summary } = await compareTool(s.ctx, { a, b });
  const rule = data.rules.find((candidate) => candidate.id === "newErrors");
  assert.equal(rule?.verdict, "pass", rule?.why);
  assert.deepEqual(rule?.b.value, []);
  assert.deepEqual(rule?.system, ["Unable to simultaneously satisfy constraints."]);
  assert.deepEqual(data.warnings.filter((warning) => warning.startsWith("New error message")), []);
  assert.match(summary, /New system messages \(com\.apple\.\*\), listed, not judged: 1 — "Unable to simultaneously satisfy constraints\."/);
});

test("marks with the same name are compared: missing, moved and changed elements are listed", async () => {
  const { ctx, a, b } = await twoSessions();
  const { data, summary } = await compareTool(ctx, { a, b });
  assert.equal(data.marks.length, 1);
  const mark = data.marks[0];
  assert.equal(mark?.name, "pin on the wrong page");
  assert.deepEqual(mark?.missing, ["ax#pinnedBadge"]);
  assert.deepEqual(mark?.moved.map((move) => move.key), ["tree#pinnedBadge"]);
  assert.equal(mark?.moved[0]?.delta, 10);
  assert.equal(mark?.textChanged.length, 1);
  assert.equal(mark?.verdict, "warn");
  assert.match(summary, /Mark "pin on the wrong page": 1 element missing, 1 moved more than 2 pt, 1 text changed/);
});

test("thresholds come from fieldbook.json", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.ctx.home, "fieldbook.json"), JSON.stringify({ formatVersion: 1, rules: { launchMedian: { ratio: 2 }, hangs: { maxIncrease: 5 } } }));
  const { loadConfig } = await import("../src/config.ts");
  s.ctx.config = loadConfig(s.ctx.home);
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const b = await record(s, "after", AFTER, "BBBBBBBB-0000-4000-8000-000000000002");
  const { data } = await compareTool(s.ctx, { a, b });
  assert.equal(data.rules.find((rule) => rule.id === "launchMedian")?.verdict, "pass");
  assert.equal(data.rules.find((rule) => rule.id === "hangs")?.verdict, "pass");
  assert.deepEqual(data.rules.find((rule) => rule.id === "launchMedian")?.thresholds, { ratio: 2, minIncreaseMs: 100 });
});

test("a session that is still recording: crashes are unchecked, not passed", async () => {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  kitOn(s.world, s.clock, PHONE_ID, "CCCCCCCC-0000-4000-8000-000000000003").launch(410);
  const { data: started } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "still going" });
  const { data, summary } = await compareTool(s.ctx, { a, b: started.session!.id });
  assert.equal(data.rules.find((rule) => rule.id === "crashes")?.verdict, "unchecked");
  assert.match(summary, /still recording/);
});

test("the same session compared with itself passes every rule", async () => {
  const { ctx, a } = await twoSessions();
  const { data } = await compareTool(ctx, { a, b: a });
  assert.ok(data.rules.every((rule) => rule.verdict === "pass"), JSON.stringify(data.rules.map((rule) => [rule.id, rule.verdict])));
  assert.ok(data.marks.every((mark) => mark.verdict === "pass"));
});

test("the comparison is saved under comparisons/", async () => {
  const { ctx, a, b } = await twoSessions();
  const { data } = await compareTool(ctx, { a, b });
  assert.ok(fs.existsSync(path.join(ctx.home, "comparisons", data.id, "comparison.json")));
});

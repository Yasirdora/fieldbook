/**
 * evidence: a small, versioned, self-contained record that a Code Director report could cite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareTool } from "../src/tools/compare.ts";
import { evidenceTool } from "../src/tools/evidence.ts";
import { twoSessions } from "./compareSetup.ts";

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("evidence for a comparison: versioned, both numbers per rule, every cited file with its sha256", async () => {
  const { ctx, a, b } = await twoSessions();
  const comparison = await compareTool(ctx, { a, b });
  const answer = await evidenceTool(ctx, { comparison: comparison.data.id });
  const file = path.join(ctx.home, "comparisons", comparison.data.id, "evidence.json");
  assert.equal(answer.data.path, file);
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(evidence.formatVersion, 1);
  assert.equal(evidence.tool, "fieldbook");
  assert.equal(evidence.toolVersion, "0.1.0");
  assert.equal(evidence.kind, "comparison");
  assert.deepEqual(evidence.sessions.map((s: any) => s.role), ["a", "b"]);
  const [before, after] = evidence.sessions;
  assert.equal(before.target, "phone");
  assert.equal(before.device.model.value, "iPhone13,3");
  assert.equal(before.device.osVersion.value, "27.0.1");
  assert.equal(before.app.version.value, "1.0");
  assert.equal(before.app.build.value, "7");
  assert.equal(before.app.commit.value, "a1b2c3d");
  assert.equal(before.build, "a1b2c3d");
  assert.equal(after.build, "e4f5a6b");
  assert.equal(after.change, "IL-0210");
  assert.ok(before.startedAt && before.endedAt);
  const launch = evidence.rules.find((rule: any) => rule.id === "launchMedian");
  assert.deepEqual(launch.thresholds, { ratio: 1.2, minIncreaseMs: 100 });
  assert.equal(launch.a.value, 400);
  assert.equal(launch.b.value, 600);
  assert.equal(launch.a.label, "measured");
  assert.equal(launch.verdict, "fail");
  assert.ok(evidence.files.length >= 5);
  for (const cited of evidence.files) {
    assert.ok(!path.isAbsolute(cited.path), cited.path);
    const full = path.join(ctx.home, cited.path);
    assert.equal(cited.sha256, sha256(full), cited.path);
    assert.equal(cited.bytes, fs.statSync(full).size);
  }
  assert.ok(evidence.files.some((cited: any) => cited.path.endsWith("comparison.json")));
  assert.match(evidence.line, /measured on the phone: crashes 0 → 1, launch 400 → 600 ms, hangs 1 → 3/);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(ctx.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute paths");
  assert.match(answer.summary, /^Wrote .*evidence\.json/);
});

test("evidence for one session: its numbers with labels, no rules", async () => {
  const { ctx, a } = await twoSessions();
  await evidenceTool(ctx, { session: a });
  const evidence = JSON.parse(fs.readFileSync(path.join(ctx.home, "sessions", a, "evidence.json"), "utf8"));
  assert.equal(evidence.kind, "session");
  assert.deepEqual(evidence.rules, []);
  assert.equal(evidence.sessions[0].role, "only");
  assert.equal(evidence.sessions[0].metrics.crashes.value, 0);
  assert.equal(evidence.sessions[0].metrics.hangs.value, 1);
  assert.ok(evidence.files.some((cited: any) => cited.path === `sessions/${a}/timeline.jsonl`));
  assert.match(evidence.line, /measured on the phone: 0 crashes, launch 400 ms, 1 hang/);
});

test("evidence needs exactly one of session or comparison", async () => {
  const { ctx, a } = await twoSessions();
  await assert.rejects(evidenceTool(ctx, {}), /exactly one/);
  await assert.rejects(evidenceTool(ctx, { session: a, comparison: "x" }), /exactly one/);
  await assert.rejects(evidenceTool(ctx, { comparison: "nope" }), /No comparison nope/);
});

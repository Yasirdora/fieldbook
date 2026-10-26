/**
 * MetricKit payloads and crash logs end up in the session bundle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { timelineTool } from "../src/tools/timeline.ts";
import { BUNDLE, MAC_BUNDLE, PHONE_ID, SIM_ID } from "./fakes/world.ts";
import { kitOn, sessionDir, setup } from "./testContext.ts";

test("a MetricKit payload is copied into metrickit/ and shown in the timeline", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "metrics" });
  const id = data.session!.id;
  clock.advance(3_000);
  const file = kit.metricKit("diagnostics");
  await ctx.recorders.get(id)?.pullOnce();
  const copied = path.join(sessionDir(ctx, id), "metrickit", path.basename(file));
  assert.ok(fs.existsSync(copied));
  const { summary } = await timelineTool(ctx, { session: id });
  assert.match(summary, /metrickit diagnostics → metrickit\//);
});

test("a MetricKit file that is not copied yet is tried again on the next pull", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "metrics" });
  const id = data.session!.id;
  const file = kit.metricKit("metrics");
  const original = path.join(world.mailbox(PHONE_ID), file);
  const held = `${original}.held`;
  fs.renameSync(original, held);
  await ctx.recorders.get(id)?.pullOnce();
  assert.equal(fs.existsSync(path.join(sessionDir(ctx, id), "metrickit", path.basename(file))), false);
  fs.renameSync(held, original);
  await ctx.recorders.get(id)?.pullOnce();
  assert.ok(fs.existsSync(path.join(sessionDir(ctx, id), "metrickit", path.basename(file))));
});

for (const [target, device, bundleId] of [
  ["simulator", SIM_ID, BUNDLE],
  ["mac", "this-mac", MAC_BUNDLE],
] as const) {
  test(`crash logs of a ${target} app come from the Mac's DiagnosticReports, new ones of this app only`, async () => {
    const { ctx, world, clock } = setup();
    const reports = path.join(world.macHome, "Library/Logs/DiagnosticReports");
    fs.writeFileSync(path.join(reports, "Sparrowpad-2026-11-01-080000.ips"), "{}");
    kitOn(world, clock, device).launch();
    const { data } = await sessionStart(ctx, {
      target,
      device: target === "mac" ? undefined : device,
      bundleId,
      label: "crash",
    });
    const id = data.session!.id;
    fs.writeFileSync(path.join(reports, "Sparrowpad-2026-11-04-101510.ips"), "{\"crash\":1}");
    fs.writeFileSync(path.join(reports, "Unrelated-2026-11-04-101510.ips"), "{}");
    const answer = await sessionStop(ctx, { session: id });
    assert.deepEqual(fs.readdirSync(path.join(sessionDir(ctx, id), "crashes")), ["Sparrowpad-2026-11-04-101510.ips"]);
    assert.match(answer.summary, /1 new crash log/);
  });
}

test("when the crash logs cannot be listed, the crash count is missing, not zero", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const { data } = await sessionStart(ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "no crash list" });
  const id = data.session!.id;
  world.phone().connected = false;
  const answer = await sessionStop(ctx, { session: id });
  assert.match(answer.summary, /Crashes: missing/);
  const session = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx, id), "session.json"), "utf8"));
  assert.equal(session.crashes.label, "missing");
});

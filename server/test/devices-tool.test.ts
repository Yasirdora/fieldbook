/**
 * The devices tool: phones, simulators and this Mac; reachable or not, locked or not, and
 * whether a bundle id is installed with container access. Every value carries its label.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { devicesTool } from "../src/tools/devices.ts";
import { BUNDLE, PAD_ID, PHONE_ID, SIM_ID, SPARE_SIM_ID } from "./fakes/world.ts";
import { setup } from "./testContext.ts";

test("lists phones, simulators and this Mac, summary first", async () => {
  const { ctx } = setup();
  const answer = await devicesTool(ctx, { bundleId: BUNDLE });
  assert.match(answer.summary.split("\n")[0] ?? "", /2 phones, 2 simulators and this Mac/);
  const data = answer.data;
  assert.deepEqual(data.phones.map((p) => p.id), [PHONE_ID, PAD_ID]);
  assert.deepEqual(data.simulators.map((s) => s.id), [SIM_ID, SPARE_SIM_ID]);
  assert.equal(data.mac.target, "mac");
});

test("a connected, unlocked phone with the app: every fact is measured", async () => {
  const { ctx } = setup();
  const { data, summary } = await devicesTool(ctx, { bundleId: BUNDLE });
  const phone = data.phones[0];
  assert.equal(phone?.name, "Test iPhone");
  assert.deepEqual(phone?.reachable, { label: "measured", value: true, source: "devicectl info lockState answered" });
  assert.equal(phone?.locked.label, "measured");
  assert.equal(phone?.locked.value, false);
  assert.equal(phone?.model.value, "iPhone13,3");
  assert.equal(phone?.app?.installed.value, true);
  assert.equal(phone?.app?.containerAccess.value, true);
  assert.equal(phone?.app?.containerAccess.label, "measured");
  assert.equal(phone?.app?.version?.value, "1.0");
  assert.equal(phone?.app?.build?.value, "7");
  assert.match(summary, /Phone "Test iPhone".*reachable, unlocked/);
});

test("a disconnected phone is not reachable, with the reason", async () => {
  const { ctx } = setup();
  const { data, summary } = await devicesTool(ctx, { bundleId: BUNDLE });
  const pad = data.phones[1];
  assert.equal(pad?.reachable.value, false);
  assert.equal(pad?.reachable.label, "measured");
  assert.match(pad?.reachable.source ?? "", /not connected/);
  assert.equal(pad?.locked.label, "missing");
  assert.equal(pad?.app, undefined);
  assert.match(summary, /Phone "Test iPad".*not reachable/);
});

test("a locked phone is reported as locked", async () => {
  const { ctx, world } = setup();
  world.phone().locked = true;
  const { data } = await devicesTool(ctx, {});
  assert.equal(data.phones[0]?.locked.value, true);
});

test("an installed app without container access says so", async () => {
  const { ctx, world } = setup();
  world.phone().containerAccess = false;
  const { data, summary } = await devicesTool(ctx, { bundleId: BUNDLE });
  assert.equal(data.phones[0]?.app?.installed.value, true);
  assert.equal(data.phones[0]?.app?.containerAccess.value, false);
  assert.match(summary, /no container access/);
});

test("simulators: booted or not; the app's container is found or not", async () => {
  const { ctx } = setup();
  const { data } = await devicesTool(ctx, { bundleId: BUNDLE });
  const [booted, spare] = data.simulators;
  assert.equal(booted?.reachable.value, true);
  assert.equal(booted?.locked.label, "missing");
  assert.equal(booted?.app?.installed.value, true);
  assert.equal(booted?.app?.containerAccess.value, true);
  assert.equal(spare?.reachable.value, false);
  assert.equal(spare?.app, undefined);
});

test("when devicectl is missing, phones are missing with the reason and the rest still works", async () => {
  const { ctx, world } = setup();
  world.brokenTools.add("devicectl");
  const { data, summary } = await devicesTool(ctx, {});
  assert.equal(data.phones.length, 0);
  assert.ok(data.problems.some((p) => /devicectl/.test(p)));
  assert.equal(data.simulators.length, 2);
  assert.match(summary, /devicectl/);
});

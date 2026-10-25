/**
 * doctor: what works on this Mac right now. Every item is measured or missing; nothing is assumed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { doctorTool } from "../src/tools/doctor.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, setup } from "./testContext.ts";

test("every item is measured or missing", async () => {
  const { ctx } = setup();
  const { data } = await doctorTool(ctx, {});
  assert.ok(data.items.length >= 5);
  for (const item of data.items) {
    assert.ok(item.label === "measured" || item.label === "missing", `${item.item}: ${item.label}`);
    assert.ok(item.detail.length > 0);
  }
});

test("tools, tunnels and real screenshots are measured", async () => {
  const { ctx } = setup();
  const { data, summary } = await doctorTool(ctx, {});
  const find = (name: string) => data.items.find((item) => item.item === name);
  assert.equal(find("devicectl")?.ok, true);
  assert.equal(find("simctl")?.ok, true);
  assert.equal(find('phone "Test iPhone": tunnel')?.ok, true);
  assert.equal(find('phone "Test iPad": tunnel')?.ok, false);
  assert.equal(find('phone "Test iPhone": screenshot')?.ok, true);
  assert.equal(find('simulator "Scratch iPhone": screenshot')?.ok, true);
  assert.equal(find("notification round trip")?.label, "missing");
  assert.match(summary.split("\n")[0] ?? "", /work/);
});

test("with a bundle id: container access and the notification round trip are measured", async () => {
  const { ctx, world, clock } = setup();
  const kit = kitOn(world, clock).launch();
  world.onNotify = (device, name) => {
    if (device === PHONE_ID && name.endsWith(".inbox")) kit.respond("notification");
  };
  const { data } = await doctorTool(ctx, { bundleId: BUNDLE, target: "phone", device: PHONE_ID });
  const access = data.items.find((item) => item.item === 'phone "Test iPhone": container access');
  assert.equal(access?.ok, true);
  const trip = data.items.find((item) => item.item === 'phone "Test iPhone": notification round trip');
  assert.equal(trip?.label, "measured");
  assert.equal(trip?.ok, true);
  assert.match(trip?.detail ?? "", /notification/);
  assert.ok(world.commandLines().some((line) => line.includes("notification post")));
});

test("when the notification does not arrive but the 2 s inbox read works, doctor says which", async () => {
  const { ctx, world, clock, duringSleep } = setup();
  const kit = kitOn(world, clock).launch();
  duringSleep.push(() => kit.respond("poll"));
  const { data } = await doctorTool(ctx, { bundleId: BUNDLE, target: "phone", device: PHONE_ID });
  const trip = data.items.find((item) => item.item === 'phone "Test iPhone": notification round trip');
  assert.equal(trip?.ok, false);
  assert.equal(trip?.label, "measured");
  assert.match(trip?.detail ?? "", /2 s inbox read/);
});

test("when the app does not answer at all, the round trip is missing with the reason", async () => {
  const { ctx, world, clock } = setup();
  kitOn(world, clock).launch();
  const { data } = await doctorTool(ctx, { bundleId: BUNDLE, target: "phone", device: PHONE_ID });
  const trip = data.items.find((item) => item.item === 'phone "Test iPhone": notification round trip');
  assert.equal(trip?.label, "missing");
  assert.match(trip?.detail ?? "", /did not answer/);
});

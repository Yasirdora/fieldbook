/**
 * Parsers for devicectl and simctl output.
 * properties.* is read first; the deprecated fields are the fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isPhoneLike, parseApps, parseDeviceList, parseFileNames, parseLockState } from "../src/devices/devicectl.ts";
import { parseSimulators } from "../src/devices/simctl.ts";
import { fixture, fixtureText } from "./helpers.ts";

test("list devices: new properties first, deprecated fields as fallback", () => {
  const devices = parseDeviceList(fixture("devicectl-list-devices.json"));
  assert.equal(devices.length, 3);
  const [phone, pad, watch] = devices;
  assert.equal(phone?.identifier, "00000000-0000-4000-8000-0000000000A1");
  assert.equal(phone?.name, "Test iPhone");
  assert.equal(phone?.productType, "iPhone13,3");
  assert.equal(phone?.osVersion, "27.0.1");
  assert.equal(phone?.from.productType, "properties");
  assert.equal(phone?.tunnelState, "connected");
  assert.equal(phone?.from.tunnelState, "deprecated");

  assert.equal(pad?.name, "Test iPad");
  assert.equal(pad?.osVersion, "27.0");
  assert.equal(pad?.from.osVersion, "deprecated");
  assert.equal(pad?.tunnelState, "disconnected");

  assert.equal(watch?.platform, "watchOS");
  assert.deepEqual(devices.filter(isPhoneLike).map((d) => d.name), ["Test iPhone", "Test iPad"]);
});

test("list devices: anything unexpected gives an empty list, not a crash", () => {
  assert.deepEqual(parseDeviceList(undefined), []);
  assert.deepEqual(parseDeviceList({ result: { devices: "nope" } }), []);
  assert.deepEqual(parseDeviceList({ result: { devices: [{ no: "identifier" }] } }), []);
});

test("lock state is measured when a known key is there, missing otherwise", () => {
  assert.deepEqual(parseLockState(fixture("devicectl-lockstate-locked.json")).value, true);
  assert.deepEqual(parseLockState(fixture("devicectl-lockstate-unlocked.json")).value, false);
  assert.equal(parseLockState(fixture("devicectl-lockstate-locked.json")).label, "measured");
  const unknown = parseLockState({ result: { somethingElse: 1 } });
  assert.equal(unknown.label, "missing");
  assert.ok(unknown.reason);
});

test("info apps gives bundle id, name, version and build", () => {
  const apps = parseApps(fixture("devicectl-info-apps.json"));
  assert.deepEqual(apps, [{ bundleId: "com.example.sparrowpad", name: "Sparrowpad", version: "1.0", build: "7" }]);
  assert.equal(parseApps({ result: {} }), undefined);
});

test("info files gives file names from any likely key", () => {
  assert.deepEqual(parseFileNames(fixture("devicectl-info-files-crashlogs.json")), [
    "OtherApp-2026-11-02-123000.ips",
    "Sparrowpad-2026-11-01-090000.ips",
  ]);
  assert.deepEqual(parseFileNames({ result: { entries: [{ path: "Logs/Sparrowpad-x.ips" }] } }), ["Sparrowpad-x.ips"]);
});

test("simctl list: iOS simulators only, with OS version and device type", () => {
  const simulators = parseSimulators(fixtureText("simctl-list-devices.json"));
  assert.deepEqual(simulators, [
    { udid: "00000000-0000-4000-8000-0000000000C1", name: "Scratch iPhone", state: "Booted", osVersion: "27.0", model: "iPhone-17-Pro" },
    { udid: "00000000-0000-4000-8000-0000000000C2", name: "Spare iPhone", state: "Shutdown", osVersion: "27.0", model: "iPhone-17" },
  ]);
  assert.deepEqual(parseSimulators("not json"), []);
});

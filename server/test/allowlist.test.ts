/**
 * The allowlist is the one gate every external command passes. These tests prove that
 * Fieldbook can build the commands it needs, and that it cannot build anything else —
 * above all install, uninstall, reboot, settings changes and --start-stopped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkArgv } from "../src/allowlist.ts";
import { devicectl } from "../src/devices/devicectl.ts";
import { simctl } from "../src/devices/simctl.ts";
import { macTools } from "../src/devices/mac.ts";
import { RefusedCommand, ToolRunner } from "../src/runner.ts";
import type { ExecRequest } from "../src/exec.ts";

const DEVICE = "00000000-0000-4000-8000-0000000000A1";
const SIM = "00000000-0000-4000-8000-0000000000C1";
const BUNDLE = "com.example.fieldbook.demo";
const MAILBOX = "Library/Application Support/Fieldbook";

/** Every command the device layer can build. */
function everyBuiltCommand(): string[][] {
  return [
    devicectl.listDevices("/tmp/out.json"),
    devicectl.infoApps(DEVICE, "/tmp/out.json", { requireContainerAccess: true, includeContainerPaths: true }),
    devicectl.infoApps(DEVICE, "/tmp/out.json", {}),
    devicectl.infoProcesses(DEVICE, "/tmp/out.json"),
    devicectl.infoDisplays(DEVICE, "/tmp/out.json"),
    devicectl.infoDetails(DEVICE, "/tmp/out.json"),
    devicectl.infoLockState(DEVICE, "/tmp/out.json"),
    devicectl.infoFiles(DEVICE, "/tmp/out.json", { domainType: "systemCrashLogs" }),
    devicectl.infoFiles(DEVICE, "/tmp/out.json", { domainType: "appDataContainer", domainIdentifier: BUNDLE, subdirectory: MAILBOX }),
    devicectl.copyFrom(DEVICE, { source: MAILBOX, destination: "/tmp/stage", domainType: "appDataContainer", domainIdentifier: BUNDLE }),
    devicectl.copyFrom(DEVICE, { source: "FieldbookDemo-2026-11-04-101530.ips", destination: "/tmp/crash.ips", domainType: "systemCrashLogs" }),
    devicectl.copyTo(DEVICE, { source: "/tmp/000001-mark.json", destination: `${MAILBOX}/inbox/000001-mark.json`, domainType: "appDataContainer", domainIdentifier: BUNDLE }),
    devicectl.captureScreenshot(DEVICE, "/tmp/shot.png"),
    devicectl.notificationPost(DEVICE, `fieldbook.${BUNDLE}.inbox`),
    devicectl.notificationObserve(DEVICE, `fieldbook.${BUNDLE}.outbox`, 10),
    devicectl.processLaunch(DEVICE, BUNDLE, { console: true, terminateExisting: true, args: [] }),
    devicectl.processLaunch(DEVICE, BUNDLE, { console: true, terminateExisting: true, args: ["-FieldbookText", "full"] }),
    simctl.listDevices(),
    simctl.getAppContainer(SIM, BUNDLE, "data"),
    simctl.screenshot(SIM, "/tmp/shot.png"),
    simctl.notify(SIM, `fieldbook.${BUNDLE}.inbox`),
    simctl.launch(SIM, BUNDLE, []),
    simctl.launch(SIM, BUNDLE, ["-FieldbookText", "full"]),
    macTools.notify(`fieldbook.${BUNDLE}.inbox`),
    macTools.screencapture(4242, "/tmp/window.png"),
  ];
}

test("every command the device layer builds passes the allowlist", () => {
  for (const argv of everyBuiltCommand()) {
    const result = checkArgv(argv);
    assert.equal(result.ok, true, `${argv.join(" ")} → ${result.ok ? "" : result.reason}`);
  }
});

const FORBIDDEN: string[][] = [
  ["xcrun", "devicectl", "device", "install", "app", "--device", DEVICE, "/tmp/App.app"],
  ["xcrun", "devicectl", "device", "uninstall", "app", "--device", DEVICE, BUNDLE],
  ["xcrun", "devicectl", "device", "reboot", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "rename", "--device", DEVICE, "--name", "Other"],
  ["xcrun", "devicectl", "device", "profile", "list", "--device", DEVICE],
  ["xcrun", "devicectl", "manage", "pair", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "pairings", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "settings", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "simulate", "location", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "orientation", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "pasteboard", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "appResize", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "sysdiagnose", "--device", DEVICE],
  ["xcrun", "devicectl", "device", "process", "launch", "--device", DEVICE, "--start-stopped", BUNDLE],
  ["xcrun", "devicectl", "device", "process", "launch", "--device", DEVICE, BUNDLE, "--start-stopped"],
  ["xcrun", "devicectl", "device", "process", "terminate", "--device", DEVICE, "--pid", "42"],
  ["xcrun", "devicectl", "device", "process", "launch", "--device", DEVICE, "--console", "--json-output", "-", BUNDLE],
  ["xcrun", "devicectl", "device", "process", "launch", "--device", DEVICE, BUNDLE, "--", "-SomethingElse", "1"],
  ["xcrun", "devicectl", "device", "copy", "to", "--device", DEVICE, "--source", "/tmp/x", "--destination", "Documents/x", "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE],
  ["xcrun", "devicectl", "device", "copy", "to", "--device", DEVICE, "--source", "/tmp/x", "--destination", `${MAILBOX}/inbox/../../Preferences/x.plist`, "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE],
  ["xcrun", "devicectl", "device", "copy", "from", "--device", DEVICE, "--source", "Documents", "--destination", "/tmp/x", "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE],
  ["xcrun", "devicectl", "device", "notification", "post", "--device", DEVICE, "--name", "com.apple.springboard.lockcomplete"],
  ["xcrun", "devicectl", "device", "info", "apps", "--device", DEVICE, "--unknown-flag"],
  ["xcrun", "devicectl", "device", "info", "apps", "--device", "$(reboot)"],
  ["xcrun", "simctl", "install", SIM, "/tmp/App.app"],
  ["xcrun", "simctl", "uninstall", SIM, BUNDLE],
  ["xcrun", "simctl", "erase", SIM],
  ["xcrun", "simctl", "boot", SIM],
  ["xcrun", "simctl", "shutdown", SIM],
  ["xcrun", "simctl", "delete", SIM],
  ["xcrun", "simctl", "privacy", SIM, "grant", "all", BUNDLE],
  ["xcrun", "simctl", "ui", SIM, "appearance", "dark"],
  ["xcrun", "simctl", "status_bar", SIM, "override", "--time", "9:41"],
  ["xcrun", "simctl", "spawn", SIM, "launchctl", "reboot"],
  ["xcrun", "simctl", "spawn", SIM, "notifyutil", "-p", "com.apple.other"],
  ["xcrun", "simctl", "launch", "--wait-for-debugger", SIM, BUNDLE],
  ["xcrun", "simctl", "openurl", SIM, "https://example.com"],
  ["notifyutil", "-p", "com.apple.other"],
  ["screencapture", "/tmp/full.png"],
  ["screencapture", "-l", "12; rm -rf ~", "/tmp/x.png"],
  ["sh", "-c", "xcrun devicectl list devices"],
  ["bash", "-lc", "anything"],
  ["rm", "-rf", "/tmp/x"],
  ["open", "-a", "Simulator"],
  [],
];

test("install, uninstall, reboot, settings, --start-stopped and every other unlisted command are refused", () => {
  for (const argv of FORBIDDEN) {
    const result = checkArgv(argv);
    assert.equal(result.ok, false, `should refuse: ${argv.join(" ")}`);
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});

test("the runner refuses a forbidden command before anything runs", async () => {
  const calls: ExecRequest[] = [];
  const runner = new ToolRunner(async (request) => {
    calls.push(request);
    return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
  }, fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "fb-runner-")));
  await assert.rejects(
    runner.run(["xcrun", "devicectl", "device", "uninstall", "app", "--device", DEVICE, BUNDLE]),
    RefusedCommand,
  );
  await assert.rejects(runner.run(["xcrun", "simctl", "erase", SIM]), RefusedCommand);
  assert.equal(calls.length, 0);
  await runner.run(devicectl.notificationPost(DEVICE, `fieldbook.${BUNDLE}.inbox`));
  assert.equal(calls.length, 1);
});

test("no source file starts processes except exec.ts, and none uses a shell", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(text, /shell:\s*true/, `${file} must not use a shell`);
    if (path.basename(file) === "exec.ts") continue;
    assert.doesNotMatch(text, /node:child_process|from "child_process"/, `${file} must run commands through runner.ts`);
  }
});

test("the server has no upload or network code", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(text, /\bfetch\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/, `${file} must not reach the network`);
  }
});

/**
 * timeline: a concise text summary of session events, with logs around a mark.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionStart } from "../src/tools/session.ts";
import { timelineTool } from "../src/tools/timeline.ts";
import { accessibilityText } from "../src/session/text.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, setup } from "./testContext.ts";

async function recorded() {
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "before fix" });
  s.clock.advance(2_100);
  kit.log("info", "Loaded 3 notes");
  s.clock.advance(3_100);
  kit.log("error", "Could not open note 42 after 3 tries", "store");
  s.clock.advance(2_000);
  kit.hang(412);
  kit.memory(52_428_800, 104_857_600);
  s.clock.advance(5_200);
  const markId = kit.shake();
  s.clock.advance(7_600);
  kit.note(markId, "The pin shows on page 2.");
  s.clock.advance(30_000);
  kit.log("info", "Much later");
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();
  return { ...s, id: data.session!.id };
}

test("the timeline reads as short lines with times since the start", async () => {
  const { ctx, id } = await recorded();
  const { summary } = await timelineTool(ctx, { session: id });
  const lines = summary.split("\n");
  assert.match(lines[0] ?? "", /^Session 20261104-101500-before-fix-[0-9a-f]{4} "before fix" — phone "Test iPhone"/);
  assert.ok(lines.includes('00:00.0 launch 391 ms'), summary);
  assert.ok(lines.includes("00:02.1 log info [list] Loaded 3 notes"), summary);
  assert.ok(lines.includes("00:05.2 log error [store] Could not open note 42 after 3 tries"), summary);
  assert.ok(lines.includes("00:06.8 hang 412 ms"), summary);
  assert.ok(lines.includes("00:12.4 mark 1 (shake) (no real capture, tree 5 nodes, accessibility 3 nodes)"), summary);
  assert.ok(lines.includes('00:20.0 note on mark 1: "The pin shows on page 2."'), summary);
  assert.ok(!lines.some((line) => /^\d\d:\d\d\.\d memory /.test(line)), "memory samples are left out by default");
  assert.match(summary, /peak memory 100\.0 MB/);
});

test("around a mark: only what happened within ±10 s", async () => {
  const { ctx, id } = await recorded();
  const { summary, data } = await timelineTool(ctx, { session: id, around: "1" });
  assert.match(summary, /mark 1/);
  assert.match(summary, /Could not open note 42/);
  assert.doesNotMatch(summary, /Loaded 3 notes/, "02.1 is more than 10 s before 12.4");
  assert.doesNotMatch(summary, /Much later/);
  assert.ok(data.entries.every((entry) => Math.abs(entry.ms - 12_400) <= 10_000));
});

test("around a mark with a custom window, and kinds as a filter", async () => {
  const { ctx, id } = await recorded();
  const narrow = await timelineTool(ctx, { session: id, around: "1", seconds: 2 });
  assert.doesNotMatch(narrow.summary, /Could not open/);
  const onlyLogs = await timelineTool(ctx, { session: id, kinds: ["log"] });
  assert.ok(onlyLogs.data.entries.every((entry) => entry.kind === "log"));
  assert.equal(onlyLogs.data.entries.length, 3);
  const memory = await timelineTool(ctx, { session: id, kinds: ["memory"] });
  assert.match(memory.summary, /memory 50\.0 MB \(peak 100\.0 MB\)/);
});

test("system log lines below error level are left out by default, and counted", async () => {
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "quiet" });
  s.clock.advance(1_000);
  kit.log("info", "Loaded 3 notes");
  kit.log("notice", "Scene will enter foreground", "Scene", "com.apple.UIKit");
  kit.log("info", "Connection activated", "connection", "com.apple.xpc");
  kit.log("error", "Failed to fetch the font", "fonts", "com.apple.CoreText");
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();

  const { summary, data: shown } = await timelineTool(s.ctx, { session: data.session!.id });
  assert.match(summary, /Loaded 3 notes/);
  assert.match(summary, /Failed to fetch the font/, "a system error stays");
  assert.doesNotMatch(summary, /Scene will enter foreground|Connection activated/);
  assert.match(summary, /\(2 system log lines below error level left out; kinds: \["log"\] shows every log line\)/);
  assert.equal(shown.entries.filter((entry) => entry.kind === "log").length, 2);

  const every = await timelineTool(s.ctx, { session: data.session!.id, kinds: ["log"] });
  assert.equal(every.data.entries.length, 4);
  assert.doesNotMatch(every.summary, /left out/);
});

test("a repeated system error shows once with its count; the app's own lines all stay", async () => {
  // Measured on an iPhone: "[API] cannot add handler to 0 from 0 - dropping" 104 times in 17 minutes.
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "loud" });
  s.clock.advance(1_000);
  kit.log("error", "cannot add handler to 0 from 0 - dropping", "API", "com.apple.UIKit");
  kit.log("error", "Could not save the garden plan", "demo");
  s.clock.advance(1_000);
  kit.log("error", "cannot add handler to 0 from 0 - dropping", "API", "com.apple.UIKit");
  kit.log("fault", "Invalid UIScreen coordinate space conversion", "UIScreen", "com.apple.UIKit");
  kit.log("error", "Could not save the garden plan", "demo");
  s.clock.advance(1_200);
  kit.log("error", "cannot add handler to 0 from 0 - dropping", "API", "com.apple.UIKit");
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();

  const { summary, data: shown } = await timelineTool(s.ctx, { session: data.session!.id });
  const lines = summary.split("\n");
  assert.equal(lines.filter((line) => line.includes("Could not save the garden plan")).length, 2, "the app's own lines are never folded");
  const handler = lines.filter((line) => line.includes("cannot add handler"));
  assert.deepEqual(handler, ["00:01.0 log error [API] cannot add handler to 0 from 0 - dropping (×3, last at 00:03.2)"]);
  assert.ok(lines.includes("00:02.0 log fault [UIScreen] Invalid UIScreen coordinate space conversion"), summary);
  assert.ok(lines.includes("(2 repeats of system error lines folded into their first line; kinds: [\"log\"] shows every log line)"), summary);
  assert.equal(shown.entries.filter((entry) => entry.kind === "log").length, 4);

  const every = await timelineTool(s.ctx, { session: data.session!.id, kinds: ["log"] });
  assert.equal(every.data.entries.length, 6);
  assert.doesNotMatch(every.summary, /×3|folded/);
});

const EMPTY_WORDS = /^accessibility tree empty \(missing: SwiftUI builds it only while VoiceOver or Accessibility Inspector is attached\)$/;

/** An ax.json with the given windows; each window root has `children` empty elements below it. */
function axFile(dir: string, windows: { type: string; children: number }[]): string {
  const frame = { x: 0, y: 0, w: 390, h: 844 };
  const node = (type: string, children: unknown[]) => ({ source: "uikit.view", type, frame, traits: [], children });
  const tree = {
    formatVersion: 1,
    limit: 5000,
    nodes: windows.reduce((sum, window) => sum + 1 + window.children, 0),
    truncated: false,
    windows: windows.map((window, index) => ({
      index,
      number: null,
      isKey: index === 0,
      title: null,
      frame,
      root: node(window.type, Array.from({ length: window.children }, () => node("AccessibilityNode", []))),
    })),
  };
  const file = path.join(dir, `ax-${windows.map((window) => window.children).join("-")}.json`);
  fs.writeFileSync(file, JSON.stringify(tree));
  return file;
}

test("an accessibility tree that is only the window reads as missing, never as measured", () => {
  assert.equal(accessibilityText(32, " (measured)"), "accessibility 32 nodes (measured)");
  for (const nodes of [0, 1]) {
    const words = accessibilityText(nodes, " (measured)");
    assert.match(words, EMPTY_WORDS);
    assert.doesNotMatch(words, /measured/);
  }
});

test("bare windows read as an empty accessibility tree, however many windows there are", () => {
  // Measured on an iPhone: the app's window and the keyboard's UITextEffectsWindow, both bare (2 nodes).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldbook-ax-"));
  const bare = axFile(dir, [{ type: "UIWindow", children: 0 }, { type: "UITextEffectsWindow", children: 0 }]);
  assert.match(accessibilityText(2, " (measured)", bare), EMPTY_WORDS);
  const filled = axFile(dir, [{ type: "UIWindow", children: 1 }, { type: "UITextEffectsWindow", children: 0 }]);
  assert.equal(accessibilityText(3, " (measured)", filled), "accessibility 3 nodes (measured)");
  assert.equal(accessibilityText(2, "", path.join(dir, "not-there.json")), "accessibility 2 nodes", "an unreadable file falls back to the count");
});

test("a mark whose ax.json has only bare windows reads as empty in the mark answer and the timeline", async () => {
  const s = setup();
  const bareWindows = (_tree: unknown, ax: any) => {
    const [first] = ax.windows;
    if (!first) throw new Error("the fixture ax.json has no window");
    first.root.children = [];
    ax.windows = [first, { ...first, index: 1, isKey: false, root: { ...first.root, type: "UITextEffectsWindow", children: [] } }];
    ax.nodes = 2;
  };
  const kit = kitOn(s.world, s.clock, PHONE_ID, undefined, bareWindows).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "bare" });
  kit.shake();
  await s.ctx.recorders.get(data.session!.id)?.pullOnce();
  const { summary } = await timelineTool(s.ctx, { session: data.session!.id });
  const markLine = summary.split("\n").find((line) => line.includes("mark 1 (shake)")) ?? "";
  assert.match(markLine, /accessibility tree empty \(missing:/, summary);
  const snapshotLines = summary.split("\n").filter((line) => line.includes(" snapshot "));
  for (const line of snapshotLines) assert.match(line, /accessibility tree empty/, line);
});

test("an unknown session or mark gives a clear message", async () => {
  const { ctx, id } = await recorded();
  await assert.rejects(timelineTool(ctx, { session: "nope" }), /No session nope/);
  await assert.rejects(timelineTool(ctx, { session: id, around: "9" }), /No mark 9/);
});

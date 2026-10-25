/**
 * The server reads the same shared fixtures as the Swift tests (fixtures/format-v1).
 * If both pass, the kit and the server agree on format version 1.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FormatError,
  buildCommand,
  completeLines,
  matchesText,
  parseCommand,
  parseEvents,
  parseHello,
  parseOutboxItem,
  parseSnapshotInfo,
  parseTree,
  sha256_8,
} from "../src/format.ts";
import { FORMAT_FIXTURES } from "./helpers.ts";

const read = (relative: string) => fs.readFileSync(path.join(FORMAT_FIXTURES, relative), "utf8");

test("text fingerprints match the shared vectors", () => {
  const { vectors } = JSON.parse(read("redaction-vectors.json")) as {
    vectors: { text: string; length: number; sha256_8: string }[];
  };
  assert.equal(vectors.length, 6);
  for (const vector of vectors) {
    assert.equal(sha256_8(vector.text), vector.sha256_8);
    assert.equal([...vector.text].length, vector.length);
  }
});

test("a query matches redacted text by fingerprint, and full text by content", () => {
  assert.equal(matchesText("Pinned", { length: 6, sha256_8: "f20c8794" }), true);
  assert.equal(matchesText("pinned", { length: 6, sha256_8: "f20c8794" }), false);
  assert.equal(matchesText("pin", { length: 6, sha256_8: "f20c8794", text: "Pinned" }), true);
  assert.equal(matchesText("Pinned", undefined), false);
});

test("hello.json is read and checked", () => {
  const hello = parseHello(read("mailbox/hello.json"));
  assert.equal(hello.bundleId, "com.example.fieldbook.demo");
  assert.equal(hello.commit, "a1b2c3d");
  assert.equal(hello.redaction, "hashed");
  const newer = JSON.stringify({ ...JSON.parse(read("mailbox/hello.json")), formatVersion: 2 });
  assert.throws(() => parseHello(newer), FormatError);
});

test("events: complete lines only, every kind typed", () => {
  const text = read("mailbox/events.jsonl");
  assert.equal(completeLines(text).length, 11);
  const { events, skipped } = parseEvents(text);
  assert.equal(events.length, 11);
  assert.equal(skipped, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["lifecycle", "launch", "memory", "log", "log", "hang", "command", "snapshot", "mark", "memory", "note"],
  );
  const hang = events[5];
  assert.equal(hang?.kind === "hang" ? hang.hang.ms : undefined, 412);
});

test("events: a line with an unknown kind or a newer format is skipped and counted", () => {
  const lines = [
    JSON.stringify({ formatVersion: 1, runId: "R", seq: 1, time: "2026-11-04T10:00:00.000Z", kind: "teleport", teleport: {} }),
    JSON.stringify({ formatVersion: 2, runId: "R", seq: 2, time: "2026-11-04T10:00:00.000Z", kind: "launch", launch: { ms: 1 } }),
    JSON.stringify({ formatVersion: 1, runId: "R", seq: 3, time: "2026-11-04T10:00:00.000Z", kind: "launch", launch: { ms: 1 } }),
  ];
  const { events, skipped } = parseEvents(lines.join("\n") + "\n");
  assert.equal(events.length, 1);
  assert.equal(skipped, 2);
});

test("outbox items, snapshot info and trees are read", () => {
  const item = parseOutboxItem(read("mailbox/outbox/000001-mark.json"));
  assert.equal(item.kind, "mark");
  assert.equal(item.snapshotId, "5c1e0a2b-0001");
  const info = parseSnapshotInfo(read("mailbox/snapshots/5c1e0a2b-0001/snapshot.json"));
  assert.deepEqual(info.parts, ["tree", "ax", "state", "rendered"]);
  const tree = parseTree(read("mailbox/snapshots/5c1e0a2b-0001/tree.json"));
  assert.equal(tree.nodes, 5);
  assert.equal(tree.windows[0]?.root.type, "UIWindow");
});

test("commands the server writes have the shape the kit reads", () => {
  const command = buildCommand({
    id: "20261104-101500-before-fix-a1b2-1",
    seq: 1,
    name: "mark",
    sentAt: new Date("2026-11-04T10:15:12.300Z"),
    args: { name: "pin on the wrong page", ask: false },
  });
  assert.deepEqual(JSON.parse(command), JSON.parse(read("command-mark.json")));
  assert.equal(parseCommand(command).name, "mark");
});

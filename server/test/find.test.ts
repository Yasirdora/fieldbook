/**
 * find: elements in a mark's view tree and accessibility tree, by identifier, label, type,
 * text or text hash. It answers "is A inside B" and the distance between two elements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { findTool, parseQuery } from "../src/tools/find.ts";
import { sessionStart } from "../src/tools/session.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, setup } from "./testContext.ts";

async function withMark() {
  const s = setup();
  const kit = kitOn(s.world, s.clock).launch();
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label: "find" });
  const id = data.session!.id;
  s.clock.advance(1_000);
  kit.shake();
  await s.ctx.recorders.get(id)?.pullOnce();
  return { ...s, id };
}

test("queries: a prefix chooses the field; no prefix searches id, label and text", () => {
  assert.deepEqual(parseQuery("id:pinnedBadge"), { field: "id", value: "pinnedBadge" });
  assert.deepEqual(parseQuery("label:Garden plan"), { field: "label", value: "Garden plan" });
  assert.deepEqual(parseQuery("hash:f20c8794"), { field: "hash", value: "f20c8794" });
  assert.deepEqual(parseQuery("Pinned"), { field: "any", value: "Pinned" });
});

test("by identifier: found in both trees, with frames and paths", async () => {
  const { ctx, id } = await withMark();
  const { data, summary } = await findTool(ctx, { session: id, mark: "1", query: "id:pinnedBadge" });
  assert.equal(data.matches.length, 2);
  const tree = data.matches.find((match) => match.source === "tree");
  assert.deepEqual(tree?.frame, { x: 300, y: 160, w: 60, h: 22 });
  assert.equal(tree?.path, "UIWindow[0]/UIScrollView[0]/UIView[0]/UILabel[1]");
  assert.equal(tree?.label, "measured");
  const ax = data.matches.find((match) => match.source === "ax");
  assert.equal(ax?.axSource, "uikit.element");
  assert.match(summary, /^2 matches for id:pinnedBadge in mark 1/);
});

test("by label, text and hash: hidden text is matched by its fingerprint", async () => {
  const { ctx, id } = await withMark();
  const byLabel = await findTool(ctx, { session: id, mark: "1", query: "label:Pinned" });
  assert.equal(byLabel.data.matches.length, 2);
  const byText = await findTool(ctx, { session: id, mark: "1", query: "text:Garden plan" });
  assert.deepEqual(byText.data.matches.map((match) => match.source), ["tree"]);
  const byHash = await findTool(ctx, { session: id, mark: "1", query: "hash:f20c8794" });
  assert.equal(byHash.data.matches.length, 2);
  const byType = await findTool(ctx, { session: id, mark: "1", query: "type:UILabel" });
  assert.equal(byType.data.matches.length, 2);
  const none = await findTool(ctx, { session: id, mark: "1", query: "label:pinned" });
  assert.equal(none.data.matches.length, 0);
  assert.match(none.summary, /No element matches label:pinned/);
});

test("is A inside B: in its subtree, and its frame lies within", async () => {
  const { ctx, id } = await withMark();
  const { data, summary } = await findTool(ctx, { session: id, mark: "1", query: "id:pinnedBadge", inside: "id:noteRow-n3" });
  assert.equal(data.inside?.answer, "yes");
  assert.equal(data.inside?.pairs[0]?.structural, true);
  assert.equal(data.inside?.pairs[0]?.geometric, true);
  assert.match(summary, /Inside id:noteRow-n3: yes/);
  const outside = await findTool(ctx, { session: id, mark: "1", query: "id:noteRow-n3", inside: "id:pinnedBadge" });
  assert.equal(outside.data.inside?.answer, "no");
});

test("distance between two elements, in points", async () => {
  const { ctx, id } = await withMark();
  const { data, summary } = await findTool(ctx, { session: id, mark: "1", query: "id:pinnedBadge", distanceTo: "text:Garden plan" });
  const pair = data.distance?.pairs[0];
  assert.equal(pair?.gap, 80);
  assert.equal(pair?.centers, 210);
  assert.match(summary, /gap 80 pt/);
});

test("an unknown mark says which marks exist", async () => {
  const { ctx, id } = await withMark();
  await assert.rejects(findTool(ctx, { session: id, mark: "7", query: "id:x" }), /No mark 7.*mark 1 \(shake\)/);
});

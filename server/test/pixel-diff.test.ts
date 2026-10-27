/**
 * scripts/pixel-diff.ts: the share of changed pixels between two PNG files
 * (the rendered and the captured screen of a mark).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { comparePngs, decodePng } from "../../scripts/pixel-diff.ts";
import { tempDir } from "./helpers.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "pixel-diff.ts");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG (8-bit RGBA, or RGB when `channels` is 3) where pixel (x, y) has the color `color(x, y)`. Rows use filter `filter`. */
function png(width: number, height: number, color: (x: number, y: number) => number[], channels = 4, filter = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.from(Array.from({ length: width }, (_, x) => color(x, y).slice(0, channels)).flat());
    const line = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const left = i >= channels ? (raw[i - channels] as number) : 0;
      const up = previous[i] as number;
      line[i] = filter === 1 ? ((raw[i] as number) - left) & 0xff : filter === 2 ? ((raw[i] as number) - up) & 0xff : (raw[i] as number);
    }
    rows.push(Buffer.concat([Buffer.from([filter]), line]));
    previous = raw;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const gradient = (x: number, y: number) => [x * 10, y * 10, 128, 255];

test("decodes 8-bit RGBA and RGB with filters", () => {
  for (const [channels, filter] of [[4, 0], [4, 1], [4, 2], [3, 0], [3, 2]]) {
    const image = decodePng(png(5, 4, gradient, channels, filter));
    assert.equal(image.width, 5);
    assert.equal(image.height, 4);
    assert.deepEqual([...image.rgba.subarray((2 * 5 + 3) * 4, (2 * 5 + 3) * 4 + 4)], [30, 20, 128, 255], `channels ${channels} filter ${filter}`);
  }
});

test("the same image: no pixel changed", () => {
  const result = comparePngs(png(10, 10, gradient), png(10, 10, gradient, 3, 1));
  assert.equal(result.changedShare, 0);
  assert.equal(result.sameSize, true);
});

test("a changed corner: the share of changed pixels, with and without a small tolerance", () => {
  const changed = (x: number, y: number) => (x < 5 && y < 2 ? [x * 10 + 40, y * 10, 128, 255] : gradient(x, y));
  const slight = (x: number, y: number) => (y === 9 ? [x * 10 + 3, y * 10, 128, 255] : changed(x, y));
  const result = comparePngs(png(10, 10, gradient), png(10, 10, slight));
  assert.equal(result.changedShare, 0.2);
  assert.equal(result.changedShareAboveTolerance, 0.1);
});

test("different sizes are compared after scaling and say so", () => {
  const result = comparePngs(png(10, 10, gradient), png(20, 20, (x, y) => gradient(Math.floor(x / 2), Math.floor(y / 2))));
  assert.equal(result.sameSize, false);
  assert.equal(result.changedShare, 0);
});

test("the command prints the share as a sentence", () => {
  const dir = tempDir("pixel");
  fs.writeFileSync(path.join(dir, "a.png"), png(10, 10, gradient));
  fs.writeFileSync(path.join(dir, "b.png"), png(10, 10, (x, y) => (x === 0 ? [255, 255, 255, 255] : gradient(x, y))));
  const result = spawnSync(process.execPath, [SCRIPT, path.join(dir, "a.png"), path.join(dir, "b.png")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /10\.0 % of pixels differ \(10\.0 % by more than 16 of 255\)/);
});

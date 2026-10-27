#!/usr/bin/env node
/**
 * pixel-diff: how much two PNG screenshots differ, as the share of changed pixels.
 *
 *   node scripts/pixel-diff.ts <a.png> <b.png>
 *
 * Used on the Mac to compare a mark's screen-rendered.png (drawn by the app) with its
 * screen-captured.png (taken by the system), for example under Liquid Glass. Reads 8-bit
 * RGB and RGBA PNGs without interlacing (what devicectl, simctl and the kit write).
 * When the sizes differ, b is scaled to a's size (nearest pixel) and the output says so.
 * No dependencies: node:zlib only.
 */
import fs from "node:fs";
import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** 4 bytes per pixel: red, green, blue, alpha. */
  rgba: Uint8Array;
}

export interface Comparison {
  width: number;
  height: number;
  sameSize: boolean;
  /** Pixels whose color differs at all, as a share of all pixels (0…1). */
  changedShare: number;
  /** Pixels where a color channel differs by more than `tolerance`. */
  changedShareAboveTolerance: number;
  tolerance: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

/** Reverses the PNG row filters (none, sub, up, average, paeth) in place. */
function unfilter(data: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] as number;
    const row = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const raw = data[row + i] as number;
      const left = i >= channels ? (out[y * stride + i - channels] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + i] as number) : 0;
      const upLeft = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] as number) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predicted === undefined) throw new Error(`unknown PNG filter ${filter}`);
      out[y * stride + i] = (raw + predicted) & 0xff;
    }
  }
  return out;
}

export function decodePng(file: Buffer): Image {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`only 8-bit RGB or RGBA PNGs without interlacing are read (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const pixels = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * channels] as number;
    rgba[i * 4 + 1] = pixels[i * channels + 1] as number;
    rgba[i * 4 + 2] = pixels[i * channels + 2] as number;
    rgba[i * 4 + 3] = channels === 4 ? (pixels[i * channels + 3] as number) : 255;
  }
  return { width, height, rgba };
}

/** The color of b at a's pixel (x, y), scaling b to a's size when they differ. */
function sample(b: Image, x: number, y: number, width: number, height: number, channel: number): number {
  const bx = Math.min(b.width - 1, Math.floor((x * b.width) / width));
  const by = Math.min(b.height - 1, Math.floor((y * b.height) / height));
  return b.rgba[(by * b.width + bx) * 4 + channel] as number;
}

export function comparePngs(fileA: Buffer, fileB: Buffer, tolerance = 16): Comparison {
  const a = decodePng(fileA);
  const b = decodePng(fileB);
  let changed = 0;
  let changedAbove = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      let largest = 0;
      for (let channel = 0; channel < 4; channel++) {
        const difference = Math.abs((a.rgba[(y * a.width + x) * 4 + channel] as number) - sample(b, x, y, a.width, a.height, channel));
        largest = Math.max(largest, difference);
      }
      if (largest > 0) changed++;
      if (largest > tolerance) changedAbove++;
    }
  }
  const total = a.width * a.height;
  return {
    width: a.width,
    height: a.height,
    sameSize: a.width === b.width && a.height === b.height,
    changedShare: changed / total,
    changedShareAboveTolerance: changedAbove / total,
    tolerance,
  };
}

function main(args: string[]): number {
  const [first, second] = args;
  if (!first || !second) {
    console.error("Usage: node scripts/pixel-diff.ts <a.png> <b.png>");
    return 2;
  }
  const result = comparePngs(fs.readFileSync(first), fs.readFileSync(second));
  const percent = (share: number) => `${(share * 100).toFixed(1)} %`;
  const size = result.sameSize ? "" : ` The sizes differ, so b was scaled to a's ${result.width}×${result.height} first.`;
  console.log(
    `${percent(result.changedShare)} of pixels differ (${percent(result.changedShareAboveTolerance)} by more than ${result.tolerance} of 255).${size}`,
  );
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

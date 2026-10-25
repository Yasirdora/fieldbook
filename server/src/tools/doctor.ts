/**
 * doctor: what works on this Mac right now. Each item is measured (it was tried) or
 * missing (it could not be tried, with the reason). Nothing is assumed.
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import { listPhones, listSimulators, thisMac } from "../devices/registry.ts";
import type { Device, Target } from "../devices/types.ts";
import { buildCommand, commandFileName, parseOutboxItem, type OutboxItem } from "../format.ts";
import { randomHex } from "../fsx.ts";
import { PhoneDevice } from "../devices/phone.ts";
import { plural, type ToolAnswer } from "./common.ts";
import { latestWindowNumber } from "../session/windows.ts";

export interface DoctorItem {
  item: string;
  label: "measured" | "missing";
  ok: boolean;
  detail: string;
}

export interface DoctorInput {
  bundleId?: string;
  target?: Target;
  device?: string;
}

const ROUND_TRIP_TRIES = 8;

const works = (item: string, detail: string): DoctorItem => ({ item, label: "measured", ok: true, detail });
const fails = (item: string, detail: string): DoctorItem => ({ item, label: "measured", ok: false, detail });
const unknown = (item: string, detail: string): DoctorItem => ({ item, label: "missing", ok: false, detail });

function title(device: Device): string {
  return `${device.target} "${device.name}"`;
}

function picked<T extends Device>(devices: T[], reference: string | undefined): T[] {
  if (!reference) return devices;
  const lower = reference.toLowerCase();
  return devices.filter((device) => device.id.toLowerCase() === lower || device.name.toLowerCase() === lower);
}

async function screenshotItem(ctx: Context, device: Device, windowNumber?: number): Promise<DoctorItem> {
  const name = `${title(device)}: screenshot`;
  const file = ctx.runner.scratchFile("doctor-screen.png");
  try {
    const shot = await device.captureScreen(file, windowNumber);
    if (shot.label === "missing") return unknown(name, shot.reason ?? "no capture");
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    return bytes > 0 ? works(name, `${shot.source}: a real capture of ${bytes} bytes`) : fails(name, `${shot.source} wrote no image`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function deviceItems(ctx: Context, device: Device, bundleId: string | undefined): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const probe = await device.probe();
  if (device.target === "phone") {
    const tunnel = device instanceof PhoneDevice ? device.listing.tunnelState : undefined;
    const detail = `tunnel ${tunnel ?? "not listed"} (devicectl list devices); ${probe.reachable.source}`;
    items.push(probe.reachable.value ? works(`${title(device)}: tunnel`, detail) : fails(`${title(device)}: tunnel`, detail));
  }
  if (probe.reachable.value !== true) return items;
  if (probe.locked.value === true) {
    items.push(unknown(`${title(device)}: screenshot`, "the phone is locked; unlock it and run doctor again"));
  } else if (device.target !== "mac") {
    items.push(await screenshotItem(ctx, device));
  }
  if (bundleId) items.push(...(await appItems(ctx, device, bundleId)));
  return items;
}

async function appItems(ctx: Context, device: Device, bundleId: string): Promise<DoctorItem[]> {
  const status = await device.appStatus(bundleId);
  const name = `${title(device)}: container access`;
  const access = status.containerAccess;
  const accessItem =
    access.label === "missing"
      ? unknown(name, access.reason ?? "unknown")
      : access.value
        ? works(name, `${bundleId}: ${access.source}`)
        : fails(name, `${bundleId}: ${access.source}`);
  const items = [accessItem];
  if (access.value === true) items.push(await roundTrip(ctx, device, bundleId));
  return items;
}

/**
 * Sends a ping command, posts the inbox notification and waits for the answer.
 * The answer says whether the app saw the notification or found the command by its 2 s inbox read.
 */
async function roundTrip(ctx: Context, device: Device, bundleId: string): Promise<DoctorItem> {
  const name = `${title(device)}: notification round trip`;
  const scratch = fs.mkdtempSync(path.join(ctx.home, "tmp", "doctor-"));
  try {
    const id = `doctor-${randomHex(6)}`;
    const seq = 900_000 + Math.floor(Math.random() * 99_999);
    const fileName = commandFileName(seq, "ping");
    const local = path.join(scratch, fileName);
    fs.writeFileSync(local, buildCommand({ id, seq, name: "ping", sentAt: ctx.now() }));
    const sent = await device.sendCommand(bundleId, local, fileName);
    if (sent.label === "missing") return unknown(name, `could not send the ping: ${sent.reason}`);
    const started = ctx.now().getTime();
    const posted = await device.notifyInbox(bundleId);
    for (let attempt = 0; attempt < ROUND_TRIP_TRIES; attempt++) {
      const answer = await findAnswer(device, bundleId, path.join(scratch, "pull"), id);
      if (answer) return judge(name, answer, (ctx.now().getTime() - started) / 1000, posted.label !== "missing");
      await ctx.sleep(1_000);
    }
    return unknown(name, `the app did not answer the ping within ${ROUND_TRIP_TRIES} s. Is it running in the foreground with FieldbookKit?`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function findAnswer(device: Device, bundleId: string, staging: string, commandId: string): Promise<OutboxItem | undefined> {
  const pulled = await device.pullMailbox(bundleId, staging);
  if (pulled.label === "missing" || !pulled.value) return undefined;
  const outbox = path.join(pulled.value, "outbox");
  if (!fs.existsSync(outbox)) return undefined;
  for (const file of fs.readdirSync(outbox)) {
    try {
      const item = parseOutboxItem(fs.readFileSync(path.join(outbox, file), "utf8"));
      if (item.commandId === commandId) return item;
    } catch {
      // Not an outbox item we can read; skip it.
    }
  }
  return undefined;
}

function judge(name: string, answer: OutboxItem, seconds: number, posted: boolean): DoctorItem {
  const time = `${seconds.toFixed(1)} s`;
  if (answer.via === "notification") {
    return works(name, `the app answered through the Darwin notification after ${time}`);
  }
  const why = posted ? "the notification was posted but did not reach the app" : "the notification could not be posted";
  return fails(name, `${why}; the app answered through its 2 s inbox read after ${time} (the fallback works)`);
}

async function macItems(ctx: Context, bundleId: string | undefined): Promise<DoctorItem[]> {
  const mac = thisMac(ctx);
  if (!bundleId) {
    return [unknown(`${title(mac)}: screenshot`, "needs a running Mac app with FieldbookKit: run doctor with target mac and its bundleId")];
  }
  const found = mac.mailboxDir(bundleId);
  const windowNumber = found ? latestWindowNumber(found.dir) : undefined;
  const items = [await screenshotItem(ctx, mac, windowNumber)];
  items.push(...(await appItems(ctx, mac, bundleId)));
  return items;
}

export async function doctorTool(ctx: Context, input: DoctorInput): Promise<ToolAnswer<{ items: DoctorItem[] }>> {
  const items: DoctorItem[] = [];
  const wants = (target: Target) => input.target === undefined || input.target === target;
  if (wants("phone")) {
    const { phones, problem } = await listPhones(ctx);
    items.push(problem ? fails("devicectl", problem) : works("devicectl", `listed ${plural(phones.length, "phone or iPad", "phones or iPads")}`));
    for (const phone of picked(phones, input.target === "phone" ? input.device : undefined)) {
      items.push(...(await deviceItems(ctx, phone, input.bundleId)));
    }
  }
  if (wants("simulator")) {
    const { simulators, problem } = await listSimulators(ctx);
    const booted = simulators.filter((simulator) => simulator.listing.state === "Booted");
    items.push(problem ? fails("simctl", problem) : works("simctl", `listed ${plural(simulators.length, "simulator")}, ${booted.length} booted`));
    for (const simulator of picked(booted, input.target === "simulator" ? input.device : undefined)) {
      items.push(...(await deviceItems(ctx, simulator, input.bundleId)));
    }
  }
  if (wants("mac")) items.push(...(await macItems(ctx, input.bundleId)));
  if (!input.bundleId) {
    items.push(unknown("notification round trip", "give a bundleId of an app that runs a Debug build with FieldbookKit"));
  }
  return { summary: doctorSummary(items), data: { items } };
}

function doctorSummary(items: DoctorItem[]): string {
  const ok = items.filter((item) => item.ok).length;
  const broken = items.filter((item) => item.label === "measured" && !item.ok).length;
  const notChecked = items.filter((item) => item.label === "missing").length;
  const head = `${ok} of ${items.length} checks work right now; ${broken} do not; ${notChecked} could not be checked.`;
  const mark = (item: DoctorItem) => (item.label === "missing" ? "?" : item.ok ? "✓" : "✗");
  return [head, ...items.map((item) => `${mark(item)} ${item.item} — ${item.detail}`)].join("\n");
}


/** Finds the phones, simulators and this Mac, and picks the one a tool asks for. */
import type { Context } from "../context.ts";
import { failureText } from "../runner.ts";
import { devicectl, isPhoneLike, parseDeviceList } from "./devicectl.ts";
import { MacDevice } from "./mac.ts";
import { PhoneDevice } from "./phone.ts";
import { parseSimulators, simctl } from "./simctl.ts";
import { SimulatorDevice } from "./simulator.ts";
import type { Device, Target } from "./types.ts";

export interface DeviceList {
  phones: PhoneDevice[];
  simulators: SimulatorDevice[];
  mac: MacDevice;
  /** Why a list could not be read (for example: devicectl is not installed). */
  problems: string[];
}

export async function listPhones(ctx: Context): Promise<{ phones: PhoneDevice[]; problem?: string }> {
  const { result, json } = await ctx.runner.runJson((out) => devicectl.listDevices(out));
  if (result.code !== 0) return { phones: [], problem: `devicectl list devices failed: ${failureText(result)}` };
  return { phones: parseDeviceList(json).filter(isPhoneLike).map((listing) => new PhoneDevice(ctx.runner, listing)) };
}

export async function listSimulators(ctx: Context): Promise<{ simulators: SimulatorDevice[]; problem?: string }> {
  const result = await ctx.runner.run(simctl.listDevices());
  if (result.code !== 0) return { simulators: [], problem: `simctl list devices failed: ${failureText(result)}` };
  return { simulators: parseSimulators(result.stdout).map((listing) => new SimulatorDevice(ctx.runner, listing, ctx.macHome)) };
}

export function thisMac(ctx: Context): MacDevice {
  return new MacDevice(ctx.runner, ctx.macHome, ctx.hostName);
}

export async function listDevices(ctx: Context): Promise<DeviceList> {
  const [phones, simulators] = await Promise.all([listPhones(ctx), listSimulators(ctx)]);
  return {
    phones: phones.phones,
    simulators: simulators.simulators,
    mac: thisMac(ctx),
    problems: [phones.problem, simulators.problem].filter((problem): problem is string => problem !== undefined),
  };
}

/** Thrown when the device a tool asks for cannot be chosen. The message says what exists. */
export class DeviceChoiceError extends Error {}

function matches(device: Device, reference: string): boolean {
  const lower = reference.toLowerCase();
  if (device.id.toLowerCase() === lower || device.name.toLowerCase() === lower) return true;
  return device instanceof PhoneDevice && device.listing.udid?.toLowerCase() === lower;
}

function choose<T extends Device>(candidates: T[], reference: string | undefined, kind: string, preferred: (device: T) => boolean): T {
  if (reference) {
    const found = candidates.find((device) => matches(device, reference));
    if (found) return found;
    throw new DeviceChoiceError(`No ${kind} "${reference}". Known: ${candidates.map((d) => `"${d.name}" (${d.id})`).join(", ") || "none"}.`);
  }
  const likely = candidates.filter(preferred);
  const pool = likely.length > 0 ? likely : candidates;
  if (pool.length === 1) return pool[0] as T;
  if (pool.length === 0) throw new DeviceChoiceError(`No ${kind} found.`);
  throw new DeviceChoiceError(`More than one ${kind}; name one with device: ${pool.map((d) => `"${d.name}" (${d.id})`).join(", ")}.`);
}

/** The device for a target. With no reference: the only phone, the only booted simulator, or this Mac. */
export async function resolveDevice(ctx: Context, target: Target, reference?: string): Promise<Device> {
  if (target === "mac") return thisMac(ctx);
  if (target === "phone") {
    const { phones, problem } = await listPhones(ctx);
    if (problem) throw new DeviceChoiceError(problem);
    return choose(phones, reference, "phone", (phone) => phone.listing.tunnelState !== "disconnected");
  }
  const { simulators, problem } = await listSimulators(ctx);
  if (problem) throw new DeviceChoiceError(problem);
  return choose(simulators, reference, "simulator", (simulator) => simulator.listing.state === "Booted");
}

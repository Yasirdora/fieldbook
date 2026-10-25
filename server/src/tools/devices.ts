/**
 * devices: phones, simulators and this Mac. For each: reachable or not, locked or not,
 * and — when a bundle id is given — whether that app is installed with container access.
 */
import type { Context } from "../context.ts";
import { listDevices } from "../devices/registry.ts";
import type { Device, DeviceSummary } from "../devices/types.ts";
import { describe, has } from "../labels.ts";
import { plural, type ToolAnswer } from "./common.ts";

export interface DevicesData {
  phones: DeviceSummary[];
  simulators: DeviceSummary[];
  mac: DeviceSummary;
  problems: string[];
}

export async function summarizeDevice(device: Device, bundleId?: string): Promise<DeviceSummary> {
  const probe = await device.probe();
  const summary: DeviceSummary = {
    target: device.target,
    id: device.id,
    name: device.name,
    model: device.model,
    osVersion: device.osVersion,
    reachable: probe.reachable,
    locked: probe.locked,
  };
  if (bundleId && probe.reachable.value === true) summary.app = await device.appStatus(bundleId);
  return summary;
}

const TITLES = { phone: "Phone", simulator: "Simulator", mac: "This Mac" } as const;

function deviceLine(summary: DeviceSummary): string {
  const facts = [summary.model.value, summary.osVersion.value ? `${summary.target === "mac" ? "macOS" : "iOS"} ${summary.osVersion.value}` : undefined]
    .filter(Boolean)
    .join(", ");
  const head = `${TITLES[summary.target]} "${summary.name}"${facts ? ` (${facts})` : ""}`;
  if (summary.reachable.value !== true) {
    const why = summary.reachable.source ?? summary.reachable.reason ?? "";
    return `${head}: not reachable${why ? ` (${why})` : ""}.`;
  }
  const state = summary.target === "simulator" ? "booted" : "reachable";
  const lock = summary.locked.label === "missing" ? "" : summary.locked.value ? ", LOCKED" : ", unlocked";
  return `${head}: ${state}${lock}.${summary.app ? ` ${appLine(summary)}` : ""}`;
}

function appLine(summary: DeviceSummary): string {
  const app = summary.app;
  if (!app) return "";
  if (app.installed.value === false) return `${app.bundleId}: not installed.`;
  if (!has(app.installed)) return `${app.bundleId}: ${describe(app.installed)}.`;
  const access =
    app.containerAccess.value === true ? "installed with container access" : `installed, no container access (${describe(app.containerAccess)})`;
  const version = app.version?.value ? `, version ${app.version.value}${app.build?.value ? ` (${app.build.value})` : ""}` : "";
  return `${app.bundleId}: ${access}${version}.`;
}

export async function devicesTool(ctx: Context, input: { bundleId?: string }): Promise<ToolAnswer<DevicesData>> {
  const list = await listDevices(ctx);
  const [phones, simulators, mac] = await Promise.all([
    Promise.all(list.phones.map((phone) => summarizeDevice(phone, input.bundleId))),
    Promise.all(list.simulators.map((simulator) => summarizeDevice(simulator, input.bundleId))),
    summarizeDevice(list.mac, input.bundleId),
  ]);
  const lines = [
    `${plural(phones.length, "phone")}, ${plural(simulators.length, "simulator")} and this Mac.`,
    ...list.problems,
    ...[...phones, ...simulators, mac].map(deviceLine),
  ];
  return { summary: lines.join("\n"), data: { phones, simulators, mac, problems: list.problems } };
}

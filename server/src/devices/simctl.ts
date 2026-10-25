/**
 * simctl: the argv builders Fieldbook uses for simulators, and the parser for the device list.
 *
 * Handles simctl commands: get_app_container <udid> <bundle> data, io <udid> screenshot,
 * spawn <udid> notifyutil -p, launch --console-pty. `list devices --json` and
 * `launch --terminate-running-process` come from simctl's help text, not from a
 * measurement; docs/TESTING-ON-MAC.md checks them.
 */

const SIMCTL = ["xcrun", "simctl"];

export const simctl = {
  listDevices: (): string[] => [...SIMCTL, "list", "devices", "--json"],
  getAppContainer: (udid: string, bundleId: string, kind: "data" | "app"): string[] => [
    ...SIMCTL,
    "get_app_container",
    udid,
    bundleId,
    kind,
  ],
  screenshot: (udid: string, file: string): string[] => [...SIMCTL, "io", udid, "screenshot", file],
  notify: (udid: string, name: string): string[] => [...SIMCTL, "spawn", udid, "notifyutil", "-p", name],
  launch: (udid: string, bundleId: string, args: readonly string[]): string[] => [
    ...SIMCTL,
    "launch",
    "--console-pty",
    "--terminate-running-process",
    udid,
    bundleId,
    ...args,
  ],
};

/** One iOS simulator from `simctl list devices --json`. */
export interface SimulatorListing {
  udid: string;
  name: string;
  /** For example "Booted" or "Shutdown". */
  state: string;
  /** For example "27.0", from the runtime name. */
  osVersion?: string;
  /** The device type, for example "iPhone-17-Pro". */
  model?: string;
}

/** Reads `{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [ … ]}}`, iOS runtimes only. */
export function parseSimulators(stdout: string): SimulatorListing[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  const runtimes = (json as { devices?: unknown }).devices;
  if (typeof runtimes !== "object" || runtimes === null) return [];
  const listings: SimulatorListing[] = [];
  for (const [runtime, devices] of Object.entries(runtimes)) {
    const match = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime);
    if (!match || !Array.isArray(devices)) continue;
    const osVersion = [match[1], match[2], match[3]].filter((part) => part !== undefined).join(".");
    for (const device of devices) {
      const entry = device as Record<string, unknown>;
      if (typeof entry.udid !== "string" || typeof entry.name !== "string") continue;
      if (entry.isAvailable === false) continue;
      const type = typeof entry.deviceTypeIdentifier === "string" ? entry.deviceTypeIdentifier.split(".").pop() : undefined;
      listings.push({
        udid: entry.udid,
        name: entry.name,
        state: typeof entry.state === "string" ? entry.state : "unknown",
        osVersion,
        model: type,
      });
    }
  }
  return listings;
}

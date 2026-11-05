/**
 * devicectl: the argv builders Fieldbook uses for phones, and the parsers for their JSON.
 *
 * Handles devicectl commands for connected devices: the
 * subcommands and flags, and the shape of `list devices`. The JSON shapes of `info apps`,
 * `info lockState` and `info files` were not measured; the parsers look for several likely
 * keys and say "missing" when none is there. docs/TESTING-ON-MAC.md checks them.
 */
import { measured, missing, type Labeled } from "../labels.ts";

const XCRUN = "xcrun";
const DEVICECTL = "devicectl";

export interface CopyOptions {
  source: string;
  destination: string;
  domainType: "appDataContainer" | "systemCrashLogs";
  domainIdentifier?: string;
}

export interface LaunchOptions {
  console: boolean;
  terminateExisting: boolean;
  /** Arguments after "--": only the sets in LAUNCH_ARGUMENT_SETS pass the allowlist. */
  args: readonly string[];
}

/** `xcrun devicectl device <words…> --device <id>` */
function device(id: string, ...words: string[]): string[] {
  return [XCRUN, DEVICECTL, "device", ...words, "--device", id];
}

/** Builders. Each returns an argv array; none is run here. */
export const devicectl = {
  listDevices: (out: string): string[] => [XCRUN, DEVICECTL, "list", "devices", "--json-output", out],

  infoApps(id: string, out: string, options: { requireContainerAccess?: boolean; includeContainerPaths?: boolean }): string[] {
    const argv = device(id, "info", "apps");
    if (options.requireContainerAccess) argv.push("--require-container-access");
    if (options.includeContainerPaths) argv.push("--include-container-paths");
    return [...argv, "--json-output", out];
  },

  infoProcesses: (id: string, out: string): string[] => [...device(id, "info", "processes"), "--json-output", out],
  infoDisplays: (id: string, out: string): string[] => [...device(id, "info", "displays"), "--json-output", out],
  infoDetails: (id: string, out: string): string[] => [...device(id, "info", "details"), "--json-output", out],
  infoLockState: (id: string, out: string): string[] => [...device(id, "info", "lockState"), "--json-output", out],

  infoFiles(id: string, out: string, options: { domainType: string; domainIdentifier?: string; subdirectory?: string }): string[] {
    const argv = [...device(id, "info", "files"), "--domain-type", options.domainType];
    if (options.domainIdentifier) argv.push("--domain-identifier", options.domainIdentifier);
    if (options.subdirectory) argv.push("--subdirectory", options.subdirectory);
    return [...argv, "--json-output", out];
  },

  copyFrom: (id: string, options: CopyOptions): string[] => copy(id, "from", options),
  copyTo: (id: string, options: CopyOptions): string[] => copy(id, "to", options),

  captureScreenshot: (id: string, destination: string): string[] => [
    ...device(id, "capture", "screenshot"),
    "--destination",
    destination,
  ],

  notificationPost: (id: string, name: string): string[] => [...device(id, "notification", "post"), "--name", name],

  notificationObserve: (id: string, name: string, seconds: number): string[] => [
    ...device(id, "notification", "observe"),
    "--name",
    name,
    "--session-timeout",
    String(seconds),
  ],

  processLaunch(id: string, bundleId: string, options: LaunchOptions): string[] {
    const argv = device(id, "process", "launch");
    if (options.terminateExisting) argv.push("--terminate-existing");
    if (options.console) argv.push("--console");
    argv.push(bundleId);
    if (options.args.length > 0) argv.push("--", ...options.args);
    return argv;
  },
};

function copy(id: string, direction: "from" | "to", options: CopyOptions): string[] {
  const argv = [
    ...device(id, "copy", direction),
    "--source",
    options.source,
    "--destination",
    options.destination,
    "--domain-type",
    options.domainType,
  ];
  if (options.domainIdentifier) argv.push("--domain-identifier", options.domainIdentifier);
  return argv;
}

// ---------------------------------------------------------------------------
// Parsers

/** One paired device from `devicectl list devices`. */
export interface DeviceListing {
  /** The CoreDevice identifier, used as --device. */
  identifier: string;
  name?: string;
  udid?: string;
  productType?: string;
  marketingName?: string;
  platform?: string;
  osVersion?: string;
  transportType?: string;
  pairingState?: string;
  /** Only in the deprecated connectionProperties. */
  tunnelState?: string;
  bootState?: string;
  /** "physical" or "simulated": devicectl lists the Mac's simulators too. */
  reality?: string;
  /** For each field: whether it came from `properties` or from the deprecated fields. */
  from: Record<string, "properties" | "deprecated">;
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Reads properties.* first, then the deprecated fields. */
export function parseDeviceList(json: unknown): DeviceListing[] {
  const devices = at(json, "result", "devices");
  if (!Array.isArray(devices)) return [];
  const listings: DeviceListing[] = [];
  for (const entry of devices) {
    const identifier = text(at(entry, "identifier"));
    if (!identifier) continue;
    const listing: DeviceListing = { identifier, from: {} };
    const field = (name: keyof DeviceListing, fresh: unknown, old: unknown) => {
      const freshText = text(fresh);
      const oldText = text(old);
      if (freshText !== undefined) {
        (listing as unknown as Record<string, unknown>)[name] = freshText;
        listing.from[name] = "properties";
      } else if (oldText !== undefined) {
        (listing as unknown as Record<string, unknown>)[name] = oldText;
        listing.from[name] = "deprecated";
      }
    };
    field("name", at(entry, "properties", "state", "name"), at(entry, "deviceProperties", "name"));
    field("udid", at(entry, "properties", "hardware", "udid"), at(entry, "hardwareProperties", "udid"));
    field("productType", at(entry, "properties", "hardware", "productType"), at(entry, "hardwareProperties", "productType"));
    field("marketingName", at(entry, "properties", "hardware", "marketingName"), at(entry, "hardwareProperties", "marketingName"));
    field("platform", at(entry, "properties", "hardware", "platform"), at(entry, "hardwareProperties", "platform"));
    field(
      "osVersion",
      at(entry, "properties", "software", "osVersionNumber", "stringValue"),
      at(entry, "deviceProperties", "osVersionNumber"),
    );
    field("transportType", at(entry, "properties", "connection", "transportType"), at(entry, "connectionProperties", "transportType"));
    field("pairingState", at(entry, "properties", "connection", "pairingState"), at(entry, "connectionProperties", "pairingState"));
    field("tunnelState", undefined, at(entry, "connectionProperties", "tunnelState"));
    field("bootState", at(entry, "properties", "state", "bootState"), at(entry, "deviceProperties", "bootState"));
    field("reality", at(entry, "properties", "hardware", "reality"), at(entry, "hardwareProperties", "reality"));
    listings.push(listing);
  }
  return listings;
}

/**
 * Phones and iPads: the devices Fieldbook records as target "phone". A simulator listed by
 * devicectl is not one; Fieldbook reaches simulators through simctl.
 */
export function isPhoneLike(listing: DeviceListing): boolean {
  if (listing.reality === "simulated") return false;
  return listing.platform === "iOS" || listing.platform === "iPadOS";
}

const LOCK_KEYS = ["passcodeRequired", "isLocked", "locked", "deviceLocked"];

/** Whether the phone is locked, from `info lockState`. The key name is not yet measured. */
export function parseLockState(json: unknown): Labeled<boolean> {
  const result = at(json, "result");
  for (const key of LOCK_KEYS) {
    const value = at(result, key);
    if (typeof value === "boolean") return measured(value, `devicectl info lockState (${key})`);
  }
  return missing("devicectl info lockState answered, but with no lock field Fieldbook knows");
}

/** One app from `info apps`. */
export interface AppListing {
  bundleId: string;
  name?: string;
  version?: string;
  build?: string;
}

export function parseApps(json: unknown): AppListing[] | undefined {
  const apps = at(json, "result", "apps");
  if (!Array.isArray(apps)) return undefined;
  return apps
    .map((app): AppListing | undefined => {
      const bundleId = text(at(app, "bundleIdentifier"));
      if (!bundleId) return undefined;
      return {
        bundleId,
        name: text(at(app, "name")),
        version: text(at(app, "version")),
        build: text(at(app, "bundleVersion")),
      };
    })
    .filter((app): app is AppListing => app !== undefined);
}

/**
 * File names from `info files`. The shape is not yet measured, so this collects every
 * string under a key named relativePath, path or name, anywhere in the result.
 */
export function parseFileNames(json: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "relativePath" || key === "path" || key === "name") && typeof entry === "string") {
        const base = entry.split("/").pop();
        if (base) names.add(base);
      } else {
        visit(entry);
      }
    }
  };
  visit(at(json, "result"));
  return [...names].sort();
}

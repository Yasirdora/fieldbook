/**
 * The allowlist: the exact commands Fieldbook may run, and nothing else.
 *
 * It is a list of allowed shapes, not a list of banned words. A command that does not
 * match one shape here is refused, so install, uninstall, reboot, settings, simulate,
 * process launch --start-stopped and every other subcommand can never run.
 * docs/SAFETY.md explains each rule.
 */

export type Check = { ok: true } | { ok: false; reason: string };

/** The mailbox folder inside the app's data container. */
export const MAILBOX_PATH = "Library/Application Support/Fieldbook";
export const INBOX_PATH = `${MAILBOX_PATH}/inbox`;

/** The only launch arguments Fieldbook passes to an app. */
export const LAUNCH_ARGUMENT_SETS: readonly (readonly string[])[] = [[], ["-FieldbookText", "full"]];

const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/;
const NOTIFICATION = /^fieldbook\.[A-Za-z0-9][A-Za-z0-9.-]*\.(inbox|outbox)$/;
const DOMAIN_TYPES = new Set(["temporary", "appDataContainer", "appGroupDataContainer", "systemCrashLogs"]);
const NEVER = ["--start-stopped", "install", "uninstall", "reboot", "erase", "settings"];

const ok: Check = { ok: true };
const refuse = (reason: string): Check => ({ ok: false, reason });

type ValueKind =
  | "flag"
  | "localPath"
  | "deviceId"
  | "domainType"
  | "bundleId"
  | "notification"
  | "seconds"
  | "displayId"
  | "devicePath"
  | "envJson";

interface DevicectlShape {
  words: string[];
  flags: Record<string, ValueKind>;
  required: string[];
  /** process launch: one bundle id after the flags, then optional "--" and Fieldbook arguments. */
  launch?: boolean;
  /** Extra rules on the parsed values. */
  rule?: (values: Map<string, string>) => Check;
}

const JSON_OUT: Record<string, ValueKind> = { "--json-output": "localPath" };

const DEVICECTL: DevicectlShape[] = [
  { words: ["list", "devices"], flags: { ...JSON_OUT, "--omit-deprecated-fields-in-json": "flag" }, required: [] },
  {
    words: ["device", "info", "apps"],
    flags: { "--device": "deviceId", "--require-container-access": "flag", "--include-container-paths": "flag", ...JSON_OUT },
    required: ["--device"],
  },
  { words: ["device", "info", "processes"], flags: { "--device": "deviceId", ...JSON_OUT }, required: ["--device"] },
  { words: ["device", "info", "displays"], flags: { "--device": "deviceId", ...JSON_OUT }, required: ["--device"] },
  { words: ["device", "info", "details"], flags: { "--device": "deviceId", ...JSON_OUT }, required: ["--device"] },
  { words: ["device", "info", "lockState"], flags: { "--device": "deviceId", ...JSON_OUT }, required: ["--device"] },
  {
    words: ["device", "info", "files"],
    flags: {
      "--device": "deviceId",
      "--domain-type": "domainType",
      "--domain-identifier": "bundleId",
      "--subdirectory": "devicePath",
      ...JSON_OUT,
    },
    required: ["--device", "--domain-type"],
    rule: readRule("--subdirectory"),
  },
  {
    words: ["device", "copy", "from"],
    flags: copyFlags("--source", "--destination"),
    required: ["--device", "--source", "--destination", "--domain-type"],
    rule: readRule("--source"),
  },
  {
    words: ["device", "copy", "to"],
    flags: copyFlags("--destination", "--source"),
    required: ["--device", "--source", "--destination", "--domain-type", "--domain-identifier"],
    rule: inboxWriteRule,
  },
  {
    words: ["device", "capture", "screenshot"],
    flags: { "--device": "deviceId", "--destination": "localPath", "--display-unique-id": "displayId", ...JSON_OUT },
    required: ["--device", "--destination"],
  },
  {
    words: ["device", "notification", "post"],
    flags: { "--device": "deviceId", "--name": "notification" },
    required: ["--device", "--name"],
  },
  {
    words: ["device", "notification", "observe"],
    flags: { "--device": "deviceId", "--name": "notification", "--session-timeout": "seconds" },
    required: ["--device", "--name"],
  },
  {
    words: ["device", "process", "launch"],
    flags: { "--device": "deviceId", "--console": "flag", "--terminate-existing": "flag", "-e": "envJson", ...JSON_OUT },
    required: ["--device"],
    launch: true,
    rule: (values) =>
      values.has("--console") && values.has("--json-output")
        ? refuse("--json-output cannot be used together with --console")
        : ok,
  },
];

/** copy from reads a device path into a Mac path; copy to is the other way round. */
function copyFlags(deviceSide: string, macSide: string): Record<string, ValueKind> {
  return {
    "--device": "deviceId",
    [deviceSide]: "devicePath",
    [macSide]: "localPath",
    "--domain-type": "domainType",
    "--domain-identifier": "bundleId",
    ...JSON_OUT,
  };
}

/**
 * Reads are allowed from the app's mailbox, or from the system crash logs (one file name).
 * `pathFlag` names the flag that holds the device-side path.
 */
function readRule(pathFlag: string) {
  return (values: Map<string, string>): Check => {
    const domain = values.get("--domain-type");
    const devicePath = values.get(pathFlag);
    if (domain === "systemCrashLogs") {
      return devicePath === undefined || !devicePath.includes("/") ? ok : refuse("a crash log is read by its file name only");
    }
    if (domain !== "appDataContainer") return refuse(`Fieldbook reads only appDataContainer and systemCrashLogs, not ${domain}`);
    if (!values.has("--domain-identifier")) return refuse("appDataContainer needs --domain-identifier <bundle id>");
    if (devicePath === undefined || !isInside(devicePath, MAILBOX_PATH)) {
      return refuse(`Fieldbook reads only inside ${MAILBOX_PATH}`);
    }
    return ok;
  };
}

/** Writes are allowed only as one command file into the app's inbox. */
function inboxWriteRule(values: Map<string, string>): Check {
  if (values.get("--domain-type") !== "appDataContainer") return refuse("Fieldbook writes only into the app's data container");
  const destination = values.get("--destination") ?? "";
  const name = destination.slice(INBOX_PATH.length + 1);
  if (!destination.startsWith(`${INBOX_PATH}/`) || !/^\d{6}-[a-z]+\.json$/.test(name)) {
    return refuse(`Fieldbook writes only command files into ${INBOX_PATH}/`);
  }
  return ok;
}

function isInside(devicePath: string, folder: string): boolean {
  return devicePath === folder || devicePath.startsWith(`${folder}/`);
}

function checkValue(kind: ValueKind, value: string | undefined, flag: string): Check {
  if (value === undefined) return refuse(`${flag} needs a value`);
  if (value.includes("\0")) return refuse(`${flag} has a NUL character`);
  switch (kind) {
    case "flag":
      return ok;
    case "localPath":
      return value.startsWith("/") ? ok : refuse(`${flag} must be an absolute path on the Mac`);
    case "deviceId":
      return DEVICE_ID.test(value) ? ok : refuse(`${flag} is not a device id`);
    case "domainType":
      return DOMAIN_TYPES.has(value) ? ok : refuse(`${flag} ${value} is not a known domain type`);
    case "bundleId":
      return BUNDLE_ID.test(value) ? ok : refuse(`${flag} is not a bundle id`);
    case "notification":
      return NOTIFICATION.test(value) ? ok : refuse(`${flag} ${value} is not a Fieldbook notification`);
    case "seconds":
      return /^\d{1,4}$/.test(value) ? ok : refuse(`${flag} must be a number of seconds`);
    case "displayId":
      return /^[A-Za-z0-9-]{1,64}$/.test(value) ? ok : refuse(`${flag} is not a display id`);
    case "devicePath":
      return !value.startsWith("/") && !value.split("/").includes("..") ? ok : refuse(`${flag} must be a relative path without ".."`);
    case "envJson":
      return isStringRecord(value) ? ok : refuse(`${flag} must be a JSON object of strings`);
  }
}

function isStringRecord(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string")
    );
  } catch {
    return false;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function checkLaunchArguments(args: readonly string[]): Check {
  return LAUNCH_ARGUMENT_SETS.some((allowed) => sameList(allowed, args))
    ? ok
    : refuse(`launch arguments must be one of: ${LAUNCH_ARGUMENT_SETS.map((set) => `[${set.join(" ")}]`).join(", ")}`);
}

function checkDevicectl(rest: string[]): Check {
  const shape = DEVICECTL.find((candidate) => sameList(candidate.words, rest.slice(0, candidate.words.length)));
  if (!shape) return refuse(`devicectl ${rest.slice(0, 3).join(" ")} is not on Fieldbook's allowlist`);
  const tokens = rest.slice(shape.words.length);
  const values = new Map<string, string>();
  let bundleId: string | undefined;
  let launchArgs: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token === "--") {
      if (!shape.launch) return refuse(`"--" is only allowed for process launch`);
      launchArgs = tokens.slice(index + 1);
      break;
    }
    if (token.startsWith("-")) {
      const kind = shape.flags[token];
      if (kind === undefined) return refuse(`${token} is not allowed for devicectl ${shape.words.join(" ")}`);
      if (values.has(token)) return refuse(`${token} is given twice`);
      const value = kind === "flag" ? "" : tokens[++index];
      const check = checkValue(kind, value, token);
      if (!check.ok) return check;
      values.set(token, value ?? "");
      continue;
    }
    if (shape.launch && bundleId === undefined) {
      if (!BUNDLE_ID.test(token)) return refuse(`${token} is not a bundle id`);
      bundleId = token;
      continue;
    }
    return refuse(`unexpected argument ${token}`);
  }
  for (const flag of shape.required) {
    if (!values.has(flag)) return refuse(`${flag} is required`);
  }
  if (shape.launch) {
    if (bundleId === undefined) return refuse("process launch needs a bundle id");
    const check = checkLaunchArguments(launchArgs);
    if (!check.ok) return check;
  }
  return shape.rule ? shape.rule(values) : ok;
}

function checkSimctl(rest: string[]): Check {
  const [command, ...args] = rest;
  switch (command) {
    case "list":
      return sameList(args, ["devices", "--json"]) ? ok : refuse("only `simctl list devices --json` is allowed");
    case "get_app_container": {
      const [udid, bundle, kind, ...extra] = args;
      if (extra.length > 0 || !udid || !DEVICE_ID.test(udid)) return refuse("get_app_container <udid> <bundle id> data|app");
      if (!bundle || !BUNDLE_ID.test(bundle)) return refuse("get_app_container needs a bundle id");
      return kind === "data" || kind === "app" ? ok : refuse("get_app_container reads only the data or app container");
    }
    case "io": {
      const [udid, verb, file, ...extra] = args;
      if (extra.length > 0 || !udid || !DEVICE_ID.test(udid) || verb !== "screenshot") return refuse("only `simctl io <udid> screenshot <file>`");
      return checkValue("localPath", file, "screenshot file");
    }
    case "spawn": {
      const [udid, program, flag, name, ...extra] = args;
      if (extra.length > 0 || !udid || !DEVICE_ID.test(udid) || program !== "notifyutil" || flag !== "-p") {
        return refuse("simctl spawn may only run `notifyutil -p <fieldbook notification>`");
      }
      return checkValue("notification", name, "notifyutil -p");
    }
    case "launch":
      return checkSimctlLaunch(args);
    default:
      return refuse(`simctl ${command ?? ""} is not on Fieldbook's allowlist`);
  }
}

function checkSimctlLaunch(args: string[]): Check {
  const allowedFlags = new Set(["--console-pty", "--terminate-running-process"]);
  let index = 0;
  while (index < args.length && (args[index] as string).startsWith("--")) {
    if (!allowedFlags.has(args[index] as string)) return refuse(`${args[index]} is not allowed for simctl launch`);
    index++;
  }
  const udid = args[index];
  const bundle = args[index + 1];
  if (!udid || !DEVICE_ID.test(udid)) return refuse("simctl launch needs a simulator udid");
  if (!bundle || !BUNDLE_ID.test(bundle)) return refuse("simctl launch needs a bundle id");
  return checkLaunchArguments(args.slice(index + 2));
}

function checkMac(argv: string[]): Check {
  const [program, ...args] = argv;
  if (program === "notifyutil") {
    const [flag, name, ...extra] = args;
    if (flag !== "-p" || extra.length > 0) return refuse("only `notifyutil -p <fieldbook notification>`");
    return checkValue("notification", name, "notifyutil -p");
  }
  if (program === "screencapture") {
    const [flag, windowId, file, ...extra] = args;
    if (flag !== "-l" || extra.length > 0 || !windowId || !/^\d{1,10}$/.test(windowId)) {
      return refuse("only `screencapture -l <window id> <file>`");
    }
    if (!file || !file.endsWith(".png")) return refuse("screencapture must write a .png file");
    return checkValue("localPath", file, "screencapture file");
  }
  return refuse(`${program ?? "(nothing)"} is not on Fieldbook's allowlist`);
}

/** Checks one argv array against the allowlist. */
export function checkArgv(argv: readonly string[]): Check {
  if (argv.length === 0) return refuse("empty command");
  const words = [...argv];
  const banned = words.find((word) => NEVER.includes(word));
  if (banned !== undefined) return refuse(`"${banned}" is never allowed`);
  if (words[0] === "xcrun" && words[1] === "devicectl") return checkDevicectl(words.slice(2));
  if (words[0] === "xcrun" && words[1] === "simctl") return checkSimctl(words.slice(2));
  return checkMac(words);
}

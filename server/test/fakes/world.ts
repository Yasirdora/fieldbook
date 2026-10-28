/**
 * A fake world of devices for tests: two phones, two simulators and this Mac, each with
 * folders on disk that stand in for app containers. It answers devicectl, simctl,
 * notifyutil and screencapture commands from recorded outputs (test/fixtures), and
 * records every command it receives.
 *
 * It plugs in as the Exec behind the real ToolRunner, so the allowlist is still checked.
 */
import fs from "node:fs";
import path from "node:path";
import type { Exec, ExecRequest, ExecResult } from "../../src/exec.ts";
import { fixture, fixtureText, tempDir } from "../helpers.ts";

export const PHONE_ID = "00000000-0000-4000-8000-0000000000A1";
export const PAD_ID = "00000000-0000-4000-8000-0000000000A2";
export const SIM_ID = "00000000-0000-4000-8000-0000000000C1";
export const SPARE_SIM_ID = "00000000-0000-4000-8000-0000000000C2";
export const BUNDLE = "com.example.sparrowpad";
export const MAC_BUNDLE = "com.example.sparrowpad.mac";
export const MAILBOX = "Library/Application Support/Fieldbook";

/** A tiny valid PNG (1×1). */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export interface FakePhone {
  connected: boolean;
  locked: boolean;
  installed: boolean;
  containerAccess: boolean;
  container: string;
  crashLogs: Map<string, string>;
}

export interface FakeSimulator {
  booted: boolean;
  installed: boolean;
  container: string;
}

type Handler = (argv: string[], request: ExecRequest) => Promise<ExecResult> | ExecResult;

const done = (stdout = "", code = 0, stderr = ""): ExecResult => ({ code, stdout, stderr, timedOut: false, aborted: false });
const fail = (stderr: string): ExecResult => done("", 1, stderr);

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export class FakeWorld {
  readonly root = tempDir("world");
  readonly macHome = path.join(this.root, "mac-home");
  readonly calls: string[][] = [];
  readonly notifications: { device: string; name: string }[] = [];
  readonly phones = new Map<string, FakePhone>();
  readonly simulators = new Map<string, FakeSimulator>();
  /** How `devicectl copy from` lays out a copied folder: inside a folder of its name, or its contents directly. */
  copyLayout: "nested" | "contents" = "nested";
  /** Lines `process launch --console` and `simctl launch --console-pty` print. */
  consoleLines = ["Sparrowpad: launched\n", "Sparrowpad: list shows 3 notes\n"];
  /** Whether `notification observe` sees the app's outbox notification. */
  outboxNotificationArrives = true;
  /** When true, `process launch` and `simctl launch` fail at once with an error. */
  launchFails = false;
  /** Crash log names whose `copy from` fails although they are listed. */
  readonly failingCopies = new Set<string>();
  /** Tools that act as if they were not installed, for example "devicectl". */
  readonly brokenTools = new Set<string>();
  /** Called after a Darwin notification is posted to a device ("this-mac" for the Mac). */
  onNotify: ((device: string, name: string) => void) | undefined;

  constructor() {
    this.phones.set(PHONE_ID, this.newPhone("phone-a1", { connected: true }));
    this.phones.set(PAD_ID, this.newPhone("phone-a2", { connected: false }));
    this.simulators.set(SIM_ID, { booted: true, installed: true, container: this.makeDir("sim-c1/data") });
    this.simulators.set(SPARE_SIM_ID, { booted: false, installed: false, container: this.makeDir("sim-c2/data") });
    this.makeDir(`mac-home/Library/Containers/${MAC_BUNDLE}/Data/${MAILBOX}`);
    this.makeDir("mac-home/Library/Logs/DiagnosticReports");
  }

  private newPhone(folder: string, options: { connected: boolean }): FakePhone {
    return {
      connected: options.connected,
      locked: false,
      installed: true,
      containerAccess: true,
      container: this.makeDir(`${folder}/container`),
      crashLogs: new Map([
        ["Sparrowpad-2026-11-01-090000.ips", "{\"old\":true}"],
        ["OtherApp-2026-11-02-123000.ips", "{\"other\":true}"],
      ]),
    };
  }

  private makeDir(relative: string): string {
    const dir = path.join(this.root, relative);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The mailbox folder of the app on a device ("this-mac" for the Mac). */
  mailbox(device: string): string {
    if (device === "this-mac") return path.join(this.macHome, "Library/Containers", MAC_BUNDLE, "Data", MAILBOX);
    const phone = this.phones.get(device);
    const container = phone?.container ?? this.simulators.get(device)?.container;
    if (!container) throw new Error(`no fake device ${device}`);
    const dir = path.join(container, MAILBOX);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  phone(id = PHONE_ID): FakePhone {
    const phone = this.phones.get(id);
    if (!phone) throw new Error(`no fake phone ${id}`);
    return phone;
  }

  /** Commands seen so far, as strings, for easy assertions. */
  commandLines(): string[] {
    return this.calls.map((argv) => argv.join(" "));
  }

  readonly exec: Exec = async (request) => {
    const argv = [...request.argv];
    this.calls.push(argv);
    return this.handlerFor(argv)(argv, request);
  };

  private handlerFor(argv: string[]): Handler {
    const [program, tool, ...rest] = argv;
    const name = program === "xcrun" ? (tool ?? "") : (program ?? "");
    if (this.brokenTools.has(name)) {
      return () => fail(`xcrun: error: unable to find utility "${name}", not a developer tool or in PATH`);
    }
    if (program === "xcrun" && tool === "devicectl") return this.devicectl(rest);
    if (program === "xcrun" && tool === "simctl") return this.simctl(rest);
    if (program === "notifyutil") return (a) => this.notify("this-mac", a[2] ?? "");
    if (program === "screencapture") return (a) => this.writePng(a[3] ?? "");
    return () => fail(`fake world: no such program ${program}`);
  }

  // -------------------------------------------------------------------------
  // devicectl

  private devicectl(rest: string[]): Handler {
    const words = rest.filter((word) => !word.startsWith("-")).slice(0, 3).join(" ");
    if (words.startsWith("list devices")) return (argv) => this.listDevices(argv);
    return (argv, request) => {
      const id = flag(argv, "--device") ?? "";
      const phone = this.phones.get(id);
      if (!phone) return fail(`ERROR: No device was found for ${id}`);
      if (!phone.connected) {
        return fail("ERROR: The device is not connected. (com.apple.dt.CoreDeviceError error 4000)");
      }
      switch (words) {
        case "device info lockState":
          return this.writeJson(argv, fixture(phone.locked ? "devicectl-lockstate-locked.json" : "devicectl-lockstate-unlocked.json"));
        case "device info apps":
          return this.infoApps(argv, phone);
        case "device info files":
          return this.infoFiles(argv, phone);
        case "device copy from":
          return this.copyFrom(argv, phone);
        case "device copy to":
          return this.copyTo(argv, phone);
        case "device capture screenshot":
          return this.writePng(flag(argv, "--destination") ?? "");
        case "device notification post":
          return this.notify(id, flag(argv, "--name") ?? "");
        case "device notification observe":
          return this.outboxNotificationArrives ? done("Observed notification\n") : fail("Timed out waiting for notification");
        case "device process launch":
          return this.console(request);
        default:
          return fail(`fake world: devicectl ${words} not faked`);
      }
    };
  }

  private listDevices(argv: string[]): ExecResult {
    const json = fixture("devicectl-list-devices.json") as { result: { devices: Record<string, any>[] } };
    for (const device of json.result.devices) {
      const phone = this.phones.get(device.identifier);
      if (phone && device.connectionProperties) {
        device.connectionProperties.tunnelState = phone.connected ? "connected" : "disconnected";
      }
    }
    return this.writeJson(argv, json);
  }

  private infoApps(argv: string[], phone: FakePhone): ExecResult {
    const json = fixture("devicectl-info-apps.json") as { result: { apps: unknown[] } };
    const requireAccess = argv.includes("--require-container-access");
    if (!phone.installed || (requireAccess && !phone.containerAccess)) json.result.apps = [];
    return this.writeJson(argv, json);
  }

  private infoFiles(argv: string[], phone: FakePhone): ExecResult {
    if (flag(argv, "--domain-type") !== "systemCrashLogs") return fail("fake world: only crash logs are listed");
    const files = [...phone.crashLogs.keys()].map((name) => ({ relativePath: name, fileSize: 100 }));
    return this.writeJson(argv, { info: { outcome: "success" }, result: { files } });
  }

  private copyFrom(argv: string[], phone: FakePhone): ExecResult {
    const source = flag(argv, "--source") ?? "";
    const destination = flag(argv, "--destination") ?? "";
    if (flag(argv, "--domain-type") === "systemCrashLogs") {
      const content = phone.crashLogs.get(source);
      if (content === undefined || this.failingCopies.has(source)) return fail("ERROR: The file couldn’t be opened because it doesn’t exist.");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
      return done();
    }
    if (!phone.containerAccess) return fail("ERROR: The app's container is not accessible.");
    const from = path.join(phone.container, source);
    if (!fs.existsSync(from)) return fail("ERROR: The file couldn’t be opened because it doesn’t exist.");
    const to = this.copyLayout === "nested" ? path.join(destination, path.basename(from)) : destination;
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    return done();
  }

  private copyTo(argv: string[], phone: FakePhone): ExecResult {
    const source = flag(argv, "--source") ?? "";
    const destination = path.join(phone.container, flag(argv, "--destination") ?? "");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return done();
  }

  // -------------------------------------------------------------------------
  // simctl

  private simctl(rest: string[]): Handler {
    const [command, ...args] = rest;
    switch (command) {
      case "list":
        return () => done(fixtureText("simctl-list-devices.json"));
      case "get_app_container":
        return () => {
          const simulator = this.simulators.get(args[0] ?? "");
          if (!simulator?.booted) return fail("Unable to lookup in current state: Shutdown");
          if (!simulator.installed) return fail("No such file or directory");
          return done(`${simulator.container}\n`);
        };
      case "io":
        return () => this.writePng(args[2] ?? "");
      case "spawn":
        return () => this.notify(args[0] ?? "", args[3] ?? "");
      case "launch":
        return (_argv, request) => this.console(request);
      default:
        return () => fail(`fake world: simctl ${command} not faked`);
    }
  }

  // -------------------------------------------------------------------------
  // shared

  private writeJson(argv: string[], json: unknown): ExecResult {
    const out = flag(argv, "--json-output");
    if (out) fs.writeFileSync(out, JSON.stringify(json));
    return done();
  }

  private writePng(file: string): ExecResult {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG);
    return done();
  }

  private notify(device: string, name: string): ExecResult {
    this.notifications.push({ device, name });
    this.onNotify?.(device, name);
    return done();
  }

  /** Prints the console lines, then runs until stopped. */
  private console(request: ExecRequest): Promise<ExecResult> {
    if (this.launchFails) return Promise.resolve(fail("ERROR: The app could not be launched. (com.apple.dt.CoreDeviceError error 10002)"));
    for (const line of this.consoleLines) request.onStdout?.(line);
    return new Promise((resolve) => {
      const stop = () => resolve({ ...done(this.consoleLines.join("")), aborted: true, code: null });
      if (request.signal?.aborted) stop();
      request.signal?.addEventListener("abort", stop, { once: true });
    });
  }
}

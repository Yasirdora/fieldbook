/**
 * The device layer: one interface, three implementations (phone, simulator, mac).
 * Every answer carries its evidence label.
 */
import type { ExecResult } from "../exec.ts";
import type { Labeled } from "../labels.ts";

export type Target = "phone" | "simulator" | "mac";

export const TARGETS: readonly Target[] = ["phone", "simulator", "mac"];

/** Whether an app is on the device, and whether Fieldbook can reach its files. */
export interface AppStatus {
  bundleId: string;
  installed: Labeled<boolean>;
  containerAccess: Labeled<boolean>;
  name?: Labeled<string>;
  version?: Labeled<string>;
  build?: Labeled<string>;
}

export interface Probe {
  reachable: Labeled<boolean>;
  locked: Labeled<boolean>;
}

/** What the devices tool shows for one device. */
export interface DeviceSummary {
  target: Target;
  id: string;
  name: string;
  model: Labeled<string>;
  osVersion: Labeled<string>;
  reachable: Labeled<boolean>;
  locked: Labeled<boolean>;
  /** Only for reachable devices, when a bundle id was given. */
  app?: AppStatus;
}

/** A long-running process (the app's console). */
export type Launch = { started: true; done: Promise<ExecResult>; command: string } | { started: false; reason: string };

export interface Device {
  readonly target: Target;
  readonly id: string;
  readonly name: string;
  readonly model: Labeled<string>;
  readonly osVersion: Labeled<string>;

  /** Is the device there, and is it locked? Measured by asking it. */
  probe(): Promise<Probe>;
  appStatus(bundleId: string): Promise<AppStatus>;
  /**
   * Copies the app's mailbox into `stagingDir` (kept between pulls). Returns the local
   * folder that holds hello.json, events.jsonl and the rest.
   */
  pullMailbox(bundleId: string, stagingDir: string): Promise<Labeled<string>>;
  /** Puts one command file into the app's inbox. */
  sendCommand(bundleId: string, localFile: string, fileName: string): Promise<Labeled<true>>;
  /** Posts fieldbook.<bundle id>.inbox. */
  notifyInbox(bundleId: string): Promise<Labeled<true>>;
  /** Waits for fieldbook.<bundle id>.outbox. Measured only where the platform allows it. */
  observeOutbox(bundleId: string, seconds: number): Promise<Labeled<boolean>>;
  /** A real screenshot. On the Mac it needs the app's window number. */
  captureScreen(destination: string, windowNumber?: number): Promise<Labeled<string>>;
  /** Relaunches the app and streams its console. */
  launch(bundleId: string, args: readonly string[], onOutput: (text: string) => void, signal: AbortSignal): Launch;
  /** Every crash log file name that exists right now (filter with isCrashLogOf). */
  crashLogNames(): Promise<Labeled<string[]>>;
  /** Copies one crash log into `destinationDir`. */
  copyCrashLog(name: string, destinationDir: string): Promise<Labeled<string>>;
}

/** A crash log of an executable is named "<executable>-YYYY-MM-DD-HHMMSS[.n].ips" (or .crash). */
export function isCrashLogOf(name: string, executable: string): boolean {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}-\\d{6}(\\.\\d+)?\\.(ips|crash)$`).test(name);
}

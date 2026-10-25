/** An iOS simulator, reached through simctl and plain file paths on this Mac. */
import fs from "node:fs";
import path from "node:path";
import { MAILBOX_PATH } from "../allowlist.ts";
import { notificationName } from "../format.ts";
import { copyTree } from "../fsx.ts";
import { captured, measured, missing, type Labeled } from "../labels.ts";
import { failureText, type ToolRunner } from "../runner.ts";
import { copyHostCrashLog, findMailboxRoot, hostCrashLogNames, NO_MAILBOX, writeIntoInbox } from "./mailboxFolder.ts";
import { simctl, type SimulatorListing } from "./simctl.ts";
import type { AppStatus, Device, Launch, Probe } from "./types.ts";

const CONSOLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export class SimulatorDevice implements Device {
  readonly target = "simulator" as const;
  readonly listing: SimulatorListing;
  private readonly runner: ToolRunner;
  private readonly macHome: string;

  constructor(runner: ToolRunner, listing: SimulatorListing, macHome: string) {
    this.runner = runner;
    this.listing = listing;
    this.macHome = macHome;
  }

  get id(): string {
    return this.listing.udid;
  }

  get name(): string {
    return this.listing.name;
  }

  get model(): Labeled<string> {
    return this.listing.model ? measured(this.listing.model, "simctl list devices") : missing("simctl listed no device type");
  }

  get osVersion(): Labeled<string> {
    return this.listing.osVersion ? measured(this.listing.osVersion, "simctl list devices") : missing("simctl listed no runtime version");
  }

  async probe(): Promise<Probe> {
    return {
      reachable: measured(this.listing.state === "Booted", `simctl list devices: ${this.listing.state}`),
      locked: missing("a simulator has no lock state that Fieldbook reads"),
    };
  }

  /** The app's data container. Read fresh each time: it moves at the app's first launch. */
  private async dataContainer(bundleId: string): Promise<Labeled<string>> {
    const result = await this.runner.run(simctl.getAppContainer(this.id, bundleId, "data"));
    const container = result.stdout.trim();
    if (result.code !== 0 || container.length === 0) return missing(`simctl get_app_container failed: ${failureText(result)}`);
    return measured(container, "simctl get_app_container");
  }

  async appStatus(bundleId: string): Promise<AppStatus> {
    const container = await this.dataContainer(bundleId);
    if (container.label === "missing") {
      return { bundleId, installed: measured(false, container.reason ?? "no container"), containerAccess: measured(false, "no container") };
    }
    let readable = true;
    try {
      fs.accessSync(container.value as string, fs.constants.R_OK);
    } catch {
      readable = false;
    }
    return {
      bundleId,
      installed: measured(true, "simctl get_app_container found its data container"),
      containerAccess: measured(readable, readable ? "the container folder is readable" : "the container folder is not readable"),
    };
  }

  private async mailboxDir(bundleId: string): Promise<Labeled<string>> {
    const container = await this.dataContainer(bundleId);
    if (container.label === "missing") return container;
    return measured(path.join(container.value as string, MAILBOX_PATH), "simctl get_app_container");
  }

  async pullMailbox(bundleId: string, stagingDir: string): Promise<Labeled<string>> {
    const source = await this.mailboxDir(bundleId);
    if (source.label === "missing") return source;
    if (!fs.existsSync(source.value as string)) return missing(NO_MAILBOX);
    copyTree(source.value as string, path.join(stagingDir, "Fieldbook"));
    const root = findMailboxRoot(stagingDir);
    return root ? measured(root, "copied from the simulator's container") : missing(NO_MAILBOX);
  }

  async sendCommand(bundleId: string, localFile: string, fileName: string): Promise<Labeled<true>> {
    const mailbox = await this.mailboxDir(bundleId);
    if (mailbox.label === "missing") return missing(mailbox.reason ?? "no container");
    return writeIntoInbox(mailbox.value as string, localFile, fileName);
  }

  async notifyInbox(bundleId: string): Promise<Labeled<true>> {
    const result = await this.runner.run(simctl.notify(this.id, notificationName(bundleId, "inbox")));
    return result.code === 0 ? measured(true, "simctl spawn notifyutil -p") : missing(`notifyutil in the simulator failed: ${failureText(result)}`);
  }

  async observeOutbox(): Promise<Labeled<boolean>> {
    return missing("Fieldbook has no allowed way to wait for a notification inside a simulator");
  }

  async captureScreen(destination: string): Promise<Labeled<string>> {
    const result = await this.runner.run(simctl.screenshot(this.id, destination));
    return result.code === 0 ? captured(destination, "simctl io screenshot") : missing(`simctl io screenshot failed: ${failureText(result)}`);
  }

  launch(bundleId: string, args: readonly string[], onOutput: (text: string) => void, signal: AbortSignal): Launch {
    const argv = simctl.launch(this.id, bundleId, args);
    const done = this.runner.run(argv, { timeoutMs: CONSOLE_TIMEOUT_MS, onStdout: onOutput, signal });
    return { started: true, done, command: argv.slice(0, 5).join(" ") };
  }

  async crashLogNames(): Promise<Labeled<string[]>> {
    return hostCrashLogNames(this.macHome);
  }

  async copyCrashLog(name: string, destinationDir: string): Promise<Labeled<string>> {
    return copyHostCrashLog(this.macHome, name, destinationDir);
  }
}

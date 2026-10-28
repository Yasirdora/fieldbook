/** A paired phone or iPad, reached through devicectl. */
import fs from "node:fs";
import path from "node:path";
import { INBOX_PATH, MAILBOX_PATH } from "../allowlist.ts";
import { notificationName } from "../format.ts";
import { captured, measured, missing, type Labeled } from "../labels.ts";
import { failureText, type ToolRunner } from "../runner.ts";
import { devicectl, parseApps, parseFileNames, parseLockState, type DeviceListing } from "./devicectl.ts";
import { findMailboxRoot, NO_MAILBOX } from "./mailboxFolder.ts";
import type { AppStatus, Device, Launch, Probe } from "./types.ts";

const PROBE_TIMEOUT_MS = 15_000;
const COPY_TIMEOUT_MS = 120_000;
const CONSOLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export class PhoneDevice implements Device {
  readonly target = "phone" as const;
  readonly listing: DeviceListing;
  private readonly runner: ToolRunner;

  constructor(runner: ToolRunner, listing: DeviceListing) {
    this.runner = runner;
    this.listing = listing;
  }

  get id(): string {
    return this.listing.identifier;
  }

  get name(): string {
    return this.listing.name ?? this.listing.marketingName ?? this.listing.identifier;
  }

  get model(): Labeled<string> {
    return this.listing.productType ? measured(this.listing.productType, "devicectl list devices") : missing("devicectl did not list a product type");
  }

  get osVersion(): Labeled<string> {
    return this.listing.osVersion ? measured(this.listing.osVersion, "devicectl list devices") : missing("devicectl did not list an OS version");
  }

  /** `info lockState` needs a working connection, so an answer also proves the phone is reachable. */
  async probe(): Promise<Probe> {
    const { result, json } = await this.runner.runJson((out) => devicectl.infoLockState(this.id, out), { timeoutMs: PROBE_TIMEOUT_MS });
    if (result.code !== 0) {
      return {
        reachable: measured(false, `devicectl info lockState failed: ${failureText(result)}`),
        locked: missing("the phone did not answer"),
      };
    }
    return { reachable: measured(true, "devicectl info lockState answered"), locked: parseLockState(json) };
  }

  async appStatus(bundleId: string): Promise<AppStatus> {
    const withAccess = await this.apps(true);
    if (!withAccess.ok) return { bundleId, installed: missing(withAccess.reason), containerAccess: missing(withAccess.reason) };
    const app = withAccess.apps.find((candidate) => candidate.bundleId === bundleId);
    const source = "devicectl info apps";
    if (app) {
      return {
        bundleId,
        installed: measured(true, source),
        containerAccess: measured(true, `${source} --require-container-access`),
        name: app.name ? measured(app.name, source) : missing("info apps listed no name"),
        version: app.version ? measured(app.version, source) : missing("info apps listed no version"),
        build: app.build ? measured(app.build, source) : missing("info apps listed no build"),
      };
    }
    const all = await this.apps(false);
    if (!all.ok) return { bundleId, installed: missing(all.reason), containerAccess: measured(false, `${source} --require-container-access`) };
    const installed = all.apps.find((candidate) => candidate.bundleId === bundleId);
    return {
      bundleId,
      installed: measured(installed !== undefined, source),
      containerAccess: measured(false, `not listed by ${source} --require-container-access (install the app from Xcode)`),
      version: installed?.version ? measured(installed.version, source) : undefined,
      build: installed?.build ? measured(installed.build, source) : undefined,
    };
  }

  private async apps(requireContainerAccess: boolean) {
    const { result, json } = await this.runner.runJson((out) =>
      devicectl.infoApps(this.id, out, { requireContainerAccess, includeContainerPaths: requireContainerAccess }),
    );
    if (result.code !== 0) return { ok: false as const, reason: `devicectl info apps failed: ${failureText(result)}` };
    const apps = parseApps(json);
    if (!apps) return { ok: false as const, reason: "devicectl info apps answered without an app list" };
    return { ok: true as const, apps };
  }

  async pullMailbox(bundleId: string, stagingDir: string): Promise<Labeled<string>> {
    // The destination always exists, so devicectl lays the copy out the same way every time.
    fs.mkdirSync(stagingDir, { recursive: true });
    const result = await this.runner.run(
      devicectl.copyFrom(this.id, { source: MAILBOX_PATH, destination: stagingDir, domainType: "appDataContainer", domainIdentifier: bundleId }),
      { timeoutMs: COPY_TIMEOUT_MS },
    );
    if (result.code !== 0) return missing(`devicectl copy from failed: ${failureText(result)}`);
    const root = findMailboxRoot(stagingDir);
    return root ? measured(root, "devicectl copy from") : missing(`the copy worked, but ${NO_MAILBOX}`);
  }

  async sendCommand(bundleId: string, localFile: string, fileName: string): Promise<Labeled<true>> {
    const result = await this.runner.run(
      devicectl.copyTo(this.id, {
        source: localFile,
        destination: `${INBOX_PATH}/${fileName}`,
        domainType: "appDataContainer",
        domainIdentifier: bundleId,
      }),
      { timeoutMs: COPY_TIMEOUT_MS },
    );
    return result.code === 0 ? measured(true, "devicectl copy to") : missing(`devicectl copy to failed: ${failureText(result)}`);
  }

  async notifyInbox(bundleId: string): Promise<Labeled<true>> {
    const result = await this.runner.run(devicectl.notificationPost(this.id, notificationName(bundleId, "inbox")));
    return result.code === 0 ? measured(true, "devicectl notification post") : missing(`devicectl notification post failed: ${failureText(result)}`);
  }

  async observeOutbox(bundleId: string, seconds: number): Promise<Labeled<boolean>> {
    const result = await this.runner.run(devicectl.notificationObserve(this.id, notificationName(bundleId, "outbox"), seconds), {
      timeoutMs: (seconds + 10) * 1000,
    });
    return measured(result.code === 0, `devicectl notification observe: ${result.code === 0 ? "seen" : failureText(result)}`);
  }

  async captureScreen(destination: string): Promise<Labeled<string>> {
    const result = await this.runner.run(devicectl.captureScreenshot(this.id, destination), { timeoutMs: 30_000 });
    return result.code === 0 ? captured(destination, "devicectl capture screenshot") : missing(`devicectl capture screenshot failed: ${failureText(result)}`);
  }

  launch(bundleId: string, args: readonly string[], onOutput: (text: string) => void, signal: AbortSignal): Launch {
    const argv = devicectl.processLaunch(this.id, bundleId, { console: true, terminateExisting: true, args });
    const done = this.runner.run(argv, { timeoutMs: CONSOLE_TIMEOUT_MS, onStdout: onOutput, signal });
    return { started: true, done, command: argv.slice(0, 6).join(" ") };
  }

  async crashLogNames(): Promise<Labeled<string[]>> {
    const { result, json } = await this.runner.runJson((out) => devicectl.infoFiles(this.id, out, { domainType: "systemCrashLogs" }));
    if (result.code !== 0) return missing(`devicectl info files (systemCrashLogs) failed: ${failureText(result)}`);
    return measured(parseFileNames(json), "devicectl info files --domain-type systemCrashLogs");
  }

  async copyCrashLog(name: string, destinationDir: string): Promise<Labeled<string>> {
    const target = path.join(destinationDir, name);
    const result = await this.runner.run(
      devicectl.copyFrom(this.id, { source: name, destination: target, domainType: "systemCrashLogs" }),
      { timeoutMs: COPY_TIMEOUT_MS },
    );
    return result.code === 0 ? measured(target, "devicectl copy from systemCrashLogs") : missing(`could not copy ${name}: ${failureText(result)}`);
  }
}

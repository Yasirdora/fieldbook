/**
 * This Mac: the app's mailbox is read through local paths, Darwin notifications are posted
 * with `notifyutil -p <name>`, and one window is captured with `screencapture -l <windowid> <file>`.
 */
import fs from "node:fs";
import path from "node:path";
import { MAILBOX_PATH } from "../allowlist.ts";
import { notificationName } from "../format.ts";
import { copyTree } from "../fsx.ts";
import { captured, measured, missing, type Labeled } from "../labels.ts";
import { failureText, type ToolRunner } from "../runner.ts";
import { copyHostCrashLog, findMailboxRoot, hostCrashLogNames, NO_MAILBOX, writeIntoInbox } from "./mailboxFolder.ts";
import type { AppStatus, Device, Launch, Probe } from "./types.ts";

export const macTools = {
  notify: (name: string): string[] => ["notifyutil", "-p", name],
  screencapture: (windowNumber: number, file: string): string[] => ["screencapture", "-l", String(windowNumber), file],
};

export const MAC_DEVICE_ID = "this-mac";

export class MacDevice implements Device {
  readonly target = "mac" as const;
  readonly id = MAC_DEVICE_ID;
  readonly name: string;
  readonly model: Labeled<string> = missing("read from the app's hello.json once a session starts");
  readonly osVersion: Labeled<string> = missing("read from the app's hello.json once a session starts");
  private readonly runner: ToolRunner;
  private readonly macHome: string;

  constructor(runner: ToolRunner, macHome: string, hostName: string) {
    this.runner = runner;
    this.macHome = macHome;
    this.name = hostName;
  }

  async probe(): Promise<Probe> {
    return {
      reachable: measured(true, "this server runs on the Mac"),
      locked: missing("Fieldbook does not read the Mac's lock state"),
    };
  }

  /** The sandboxed container's mailbox, or the mailbox of an app without sandbox (docs/FORMAT.md). */
  mailboxDir(bundleId: string): { dir: string; sandboxed: boolean } | undefined {
    const container = path.join(this.macHome, "Library", "Containers", bundleId, "Data");
    if (fs.existsSync(container)) return { dir: path.join(container, MAILBOX_PATH), sandboxed: true };
    const plain = path.join(this.macHome, MAILBOX_PATH, "mailbox", bundleId);
    if (fs.existsSync(plain)) return { dir: plain, sandboxed: false };
    return undefined;
  }

  async appStatus(bundleId: string): Promise<AppStatus> {
    const found = this.mailboxDir(bundleId);
    if (!found) {
      const reason = "no container or mailbox for this bundle id yet; Fieldbook cannot tell whether a Mac app is installed until it has run once";
      return { bundleId, installed: missing(reason), containerAccess: missing(reason) };
    }
    const what = found.sandboxed ? "its sandbox container exists" : "its mailbox folder exists";
    try {
      fs.readdirSync(found.dir);
      return { bundleId, installed: measured(true, what), containerAccess: measured(true, `read ${found.dir}`) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const reason = code === "EPERM" || code === "EACCES" ? "macOS refused to let this process read it (privacy setting)" : (error as Error).message;
      return { bundleId, installed: measured(true, what), containerAccess: measured(false, reason) };
    }
  }

  async pullMailbox(bundleId: string, stagingDir: string): Promise<Labeled<string>> {
    const found = this.mailboxDir(bundleId);
    if (!found || !fs.existsSync(found.dir)) return missing(NO_MAILBOX);
    try {
      copyTree(found.dir, path.join(stagingDir, "Fieldbook"));
    } catch (error) {
      return missing(`could not read ${found.dir}: ${(error as Error).message}`);
    }
    const root = findMailboxRoot(stagingDir);
    return root ? measured(root, `copied from ${found.dir}`) : missing(NO_MAILBOX);
  }

  async sendCommand(bundleId: string, localFile: string, fileName: string): Promise<Labeled<true>> {
    const found = this.mailboxDir(bundleId);
    if (!found) return missing(NO_MAILBOX);
    return writeIntoInbox(found.dir, localFile, fileName);
  }

  async notifyInbox(bundleId: string): Promise<Labeled<true>> {
    const result = await this.runner.run(macTools.notify(notificationName(bundleId, "inbox")));
    return result.code === 0 ? measured(true, "notifyutil -p") : missing(`notifyutil failed: ${failureText(result)}`);
  }

  async observeOutbox(): Promise<Labeled<boolean>> {
    return missing("Fieldbook has no allowed command to wait for a notification on the Mac");
  }

  async captureScreen(destination: string, windowNumber?: number): Promise<Labeled<string>> {
    if (windowNumber === undefined) return missing("the app's window number is not known yet (it comes with the app's snapshot)");
    const result = await this.runner.run(macTools.screencapture(windowNumber, destination));
    if (result.code !== 0) return missing(`screencapture failed: ${failureText(result)}`);
    if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
      return missing("screencapture wrote no image (is Screen Recording allowed for this process?)");
    }
    return captured(destination, `screencapture -l ${windowNumber}`);
  }

  launch(): Launch {
    return { started: false, reason: "Fieldbook cannot relaunch a Mac app; start it from Xcode, then start the session" };
  }

  async crashLogNames(): Promise<Labeled<string[]>> {
    return hostCrashLogNames(this.macHome);
  }

  async copyCrashLog(name: string, destinationDir: string): Promise<Labeled<string>> {
    return copyHostCrashLog(this.macHome, name, destinationDir);
  }
}

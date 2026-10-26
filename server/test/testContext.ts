/** Builds a server Context on top of the fake world, with a test clock and a fast sleep. */
import path from "node:path";
import { createContext, type Context } from "../src/context.ts";
import { FakeKit, TestClock } from "./fakes/kit.ts";
import { BUNDLE, FakeWorld, MAC_BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { tempDir } from "./helpers.ts";

export interface TestSetup {
  world: FakeWorld;
  clock: TestClock;
  ctx: Context;
  /** Runs while the server "sleeps" (e.g. while waiting for an answer); tests use it to let the kit act. */
  duringSleep: (() => void)[];
}

export function setup(): TestSetup {
  const world = new FakeWorld();
  const clock = new TestClock();
  const duringSleep: (() => void)[] = [];
  const ctx = createContext({
    exec: world.exec,
    home: tempDir("home"),
    macHome: world.macHome,
    hostName: "Test Mac",
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
      for (const step of duringSleep) step();
    },
    autoPull: false,
  });
  return { world, clock, ctx, duringSleep };
}

/** A fake kit in the app's mailbox on the given device. */
export function kitOn(
  world: FakeWorld,
  clock: TestClock,
  device = PHONE_ID,
  runId?: string,
  editTrees?: (tree: any, ax: any) => void,
): FakeKit {
  const bundleId = device === "this-mac" ? MAC_BUNDLE : BUNDLE;
  return new FakeKit(world.mailbox(device), {
    bundleId,
    now: clock.now,
    runId,
    platform: device === "this-mac" ? "macOS" : "iOS",
    editTrees,
  });
}

export function sessionDir(ctx: Context, id: string): string {
  return path.join(ctx.home, "sessions", id);
}

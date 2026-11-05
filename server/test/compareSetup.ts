/** Two recorded sessions of the same steps — "before" and "after" — for compare and evidence tests. */
import { sessionStart, sessionStop } from "../src/tools/session.ts";
import { BUNDLE, PHONE_ID } from "./fakes/world.ts";
import { kitOn, setup } from "./testContext.ts";

const MB = 1024 * 1024;

export interface Steps {
  launchMs: number;
  hangs: number[];
  peakMb: number;
  errors: string[];
  /** Error lines from Apple's frameworks (subsystem com.apple.UIKit). */
  systemErrors?: string[];
  crash?: string;
  editTrees?: (tree: any, ax: any) => void;
}

export const BEFORE: Steps = { launchMs: 400, hangs: [300], peakMb: 100, errors: ["Could not open note 42 after 3 tries"] };

export const AFTER: Steps = {
  launchMs: 600,
  hangs: [300, 450, 260],
  peakMb: 120,
  errors: ["Could not open note 7 after 2 tries", "Could not save note 7"],
  crash: "Sparrowpad-2026-11-04-110000.ips",
  editTrees: (tree, ax) => {
    const row = tree.windows[0].root.children[0].children[0];
    row.children[1].frame.x = 310; // the pinned badge moved 10 pt
    row.children[0].text.sha256_8 = "00000000"; // the title text changed
    ax.windows[0].root.children.pop(); // the badge is gone from the accessibility tree
  },
};

/** Records one session with the given steps on the fake phone and stops it. Returns its id. */
export async function record(s: ReturnType<typeof setup>, label: string, steps: Steps, runId: string): Promise<string> {
  const kit = kitOn(s.world, s.clock, PHONE_ID, runId, steps.editTrees).launch(steps.launchMs);
  const { data } = await sessionStart(s.ctx, { target: "phone", device: PHONE_ID, bundleId: BUNDLE, label, build: label === "before" ? "a1b2c3d" : "e4f5a6b", change: "IL-0210" });
  const id = data.session!.id;
  s.clock.advance(1_000);
  for (const ms of steps.hangs) kit.hang(ms);
  kit.memory(steps.peakMb * MB * 0.8, steps.peakMb * MB);
  for (const message of steps.errors) kit.log("error", message, "store");
  for (const message of steps.systemErrors ?? []) kit.log("error", message, "LayoutConstraints", "com.apple.UIKit");
  s.clock.advance(2_000);
  kit.shake("pin on the wrong page");
  if (steps.crash) s.world.phone().crashLogs.set(steps.crash, "{\"crash\":true}");
  s.clock.advance(5_000);
  await sessionStop(s.ctx, { session: id });
  s.clock.advance(60_000);
  return id;
}

export async function twoSessions() {
  const s = setup();
  const a = await record(s, "before", BEFORE, "AAAAAAAA-0000-4000-8000-000000000001");
  const b = await record(s, "after", AFTER, "BBBBBBBB-0000-4000-8000-000000000002");
  return { ...s, a, b };
}

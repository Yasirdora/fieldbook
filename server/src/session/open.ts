/**
 * One recorder per session. A session that an earlier server process started is reopened
 * here; two calls that arrive at the same time share the same recorder.
 */
import type { Context } from "../context.ts";
import { DeviceChoiceError, resolveDevice } from "../devices/registry.ts";
import { ToolError } from "../tools/common.ts";
import { Recorder } from "./recorder.ts";
import type { SessionFile, SessionStore } from "./store.ts";

export async function recorderFor(ctx: Context, store: SessionStore, session: SessionFile): Promise<Recorder> {
  const existing = ctx.recorders.get(session.id);
  if (existing) return existing;
  const pending = ctx.opening.get(session.id);
  if (pending) return pending;
  const opening = open(ctx, store, session.id);
  ctx.opening.set(session.id, opening);
  try {
    return await opening;
  } finally {
    ctx.opening.delete(session.id);
  }
}

async function open(ctx: Context, store: SessionStore, id: string): Promise<Recorder> {
  const session = store.read(id);
  try {
    const device = await resolveDevice(ctx, session.target, session.device.id);
    const recorder = new Recorder(ctx, store, device, store.read(id));
    ctx.recorders.set(id, recorder);
    if (ctx.autoPull) recorder.startTimer();
    return recorder;
  } catch (error) {
    if (error instanceof DeviceChoiceError) throw new ToolError(`Cannot reach the device of ${id}: ${error.message}`);
    throw error;
  }
}

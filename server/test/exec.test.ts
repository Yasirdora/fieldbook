/**
 * realExec runs an argv array directly (no shell), stops at its timeout, streams output and can be stopped.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { realExec } from "../src/exec.ts";

const NODE = process.execPath;

test("arguments are passed as they are, with no shell", async () => {
  const result = await realExec({
    argv: [NODE, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(echo hi)", "a b; rm -rf /"],
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["$(echo hi)", "a b; rm -rf /"]);
});

test("a command that runs too long is stopped and says so", async () => {
  const started = Date.now();
  const result = await realExec({ argv: [NODE, "-e", "setTimeout(() => {}, 60000)"], timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
});

test("output can be streamed and the command stopped from outside", async () => {
  const controller = new AbortController();
  const chunks: string[] = [];
  const result = await realExec({
    argv: [NODE, "-e", "console.log('line one'); setInterval(() => {}, 1000)"],
    timeoutMs: 30_000,
    signal: controller.signal,
    onStdout: (text) => {
      chunks.push(text);
      if (chunks.join("").includes("line one")) controller.abort();
    },
  });
  assert.equal(result.aborted, true);
  assert.match(chunks.join(""), /line one/);
});

test("a missing program is an error result, not a crash", async () => {
  const result = await realExec({ argv: ["fieldbook-no-such-program"], timeoutMs: 5_000 });
  assert.equal(result.code, null);
  assert.ok(result.error);
});

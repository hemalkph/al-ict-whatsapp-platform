import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { fixture, startChild } from "./process-harness";

// Opt-in, database-free study. Retain every outcome, including failures; never retry a failed cycle.
const path = process.argv[2];
assert(
  path,
  "usage: node --import tsx src/modules/bot-worker/__fixtures__/shutdown-study.mts OUTPUT.jsonl",
);
const phase = process.env.SHUTDOWN_STUDY_PHASE ?? "normal";
let failures = 0;
let cycles = 0;
const cycle = async (worker: string, signal: "SIGTERM" | "SIGINT", n: number, scenario: string) => {
  cycles++;
  const pending = scenario === "pending" || scenario === "work-deadline";
  const w = startChild(fixture, {
    CHILD_WORKER: worker,
    CHILD_BLOCK_MS: phase === "cpu" ? "150" : "0",
    CHILD_WORK: pending ? "pending" : "idle",
    CHILD_CLOSE: scenario === "repeat" ? "hold" : scenario,
    CHILD_GRACE_MS: scenario === "hang" || scenario === "work-deadline" ? "300" : "10000",
  });
  try {
    await w.waitFor(pending ? /operation-start/ : /child-ready/);
    w.signal(signal);
    await w.waitFor(/shutdown-start/);
    if (scenario === "pending") await w.release("release-work");
    if (scenario === "repeat") {
      await w.waitFor(/pool-close-start/);
      const again = signal === "SIGTERM" ? "SIGINT" : "SIGTERM";
      w.signal(again);
      await w.waitFor(new RegExp(`"signal":"${again}"`));
      await w.release("release-close");
    }
    const r = await w.done;
    appendFileSync(
      path,
      JSON.stringify({ phase, worker, sentSignal: signal, n, scenario, ...r }) + "\n",
    );
    const failedClose = ["reject", "hang", "work-deadline"].includes(scenario);
    assert.equal(r.code, failedClose ? 1 : 0, r.out);
    assert.equal(r.signal, null, r.out);
    assert.equal(r.out.split('"event":"pool-close-start"').length - 1, 1, r.out);
    if (failedClose) {
      assert.match(r.out, scenario === "reject" ? /pool_close_failed/ : /shutdown_deadline/);
      assert.doesNotMatch(r.out, /worker[._]stopped/);
    } else assert.match(r.out, /pool-close-complete/);
  } catch (error) {
    failures++;
    w.child.kill("SIGKILL");
    await w.done.catch(() => undefined);
    appendFileSync(
      path,
      JSON.stringify({
        phase,
        worker,
        sentSignal: signal,
        n,
        scenario,
        error: String(error),
        out: w.output(),
      }) + "\n",
    );
  }
};
const scenarios =
  phase === "faults" ? ["repeat", "reject", "hang", "pending", "work-deadline"] : ["clean"];
for (let n = 0; n < (phase === "faults" ? 1 : 10); n++) {
  const jobs = [];
  for (const worker of ["bot", "webhook", "outbound"])
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      for (const scenario of scenarios) {
        if (phase === "normal") await cycle(worker, signal, n, scenario);
        else jobs.push(cycle(worker, signal, n, scenario));
      }
  await Promise.all(jobs);
}
console.log(JSON.stringify({ phase, cycles, failures }));
process.exitCode = failures ? 1 : 0;

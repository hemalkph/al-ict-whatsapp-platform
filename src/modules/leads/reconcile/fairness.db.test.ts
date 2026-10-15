import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contactLockKey } from "../locks";
import { runReconciliation } from "./run";
import { DEFAULT_OPTIONS } from "./config";
import { addContact, addTouch, fixture, injectFailure, minutesAgo, type Fixture } from "./testing";

// Reviews C-L1 and the fairness correction. (1) Every candidate is counted ONCE and under the reason it was passed over: lock
// contention is `busy`, the first-touch policy hold is `waiting`; the two never mix. (2) A persistently busy prefix does not stop
// repeated runs, even separate processes, from reaching the eligible work behind it: a contact whose advisory lock is held, and a
// touch held back by the policy, are left out of the scan by the query itself, so they cost no part of a run's scan budget and a
// run is not "used up" by them. Real locks, and the real command as separate processes.

describe("lead reconciler: honest counters and progress across runs", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => f.close());

  const linked = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const count = async (sql: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`)).n;
  async function holdContacts(contactIds: string[]) {
    const c = await f.t.pool.connect();
    await c.query("begin");
    for (const id of contactIds)
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(f.w.org.id, id),
      ]);
    return {
      async release() {
        await c.query("commit");
        c.release();
      },
    };
  }

  it("C-L1. one earlier RETRY and three newer touches, with NO lock contention: the three are `waiting`, none is `busy`, nothing is counted twice", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(40) }); // the earlier touch: its creation fails
    const newer = [];
    for (const m of [30, 20, 10])
      newer.push(await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(m) }));
    await injectFailure(f.t, "CREATED");
    const report = await f.run();
    expect(report).toMatchObject({
      retryScheduled: 1,
      waiting: 3,
      busy: 0,
      conflicts: 0,
      created: 0,
      linked: 0,
    });
    // every candidate once: the failed one is `processed`, the three held ones are `waiting`
    expect(report.scanned).toBe(4);
    expect(report.scanned).toBe(
      report.processed + report.busy + report.waiting + report.conflicts + report.gone,
    );
    for (const t of newer) expect(await linked(t.id)).toBeNull();
    expect(await count("lead_reconcile_decisions")).toBe(1); // the waiting ones were not decided or charged
    expect(report.remaining).toMatchObject({ known: true, due: 3, retryWaiting: 1 });
    // a later run within the hold does not even see them (so they are not counted as anything)
    expect(await f.run()).toMatchObject({ scanned: 0, waiting: 0, busy: 0 });
  });

  it("C-L1. genuinely busy contacts are `busy` (and only those), next to waiting work, in the same run, each candidate counted once", async () => {
    const held = await addContact(f.t.db, f.w.org.id);
    const waiting = await addContact(f.t.db, f.w.org.id);
    const a = await addTouch(f.t.db, f.w, waiting.id, { receivedAt: minutesAgo(50) });
    const h1 = await addTouch(f.t.db, f.w, held.id, { receivedAt: minutesAgo(40) });
    const h2 = await addTouch(f.t.db, f.w, held.id, { receivedAt: minutesAgo(39) });
    const later = [];
    for (const m of [30, 20, 10])
      later.push(await addTouch(f.t.db, f.w, waiting.id, { receivedAt: minutesAgo(m) }));
    await injectFailure(f.t, "CREATED", waiting.id); // the first touch of the `waiting` contact fails; the other contact is healthy
    const state: { lock?: Awaited<ReturnType<typeof holdContacts>> } = {};
    let calls = 0;
    try {
      const report = await runReconciliation(f.t.db, DEFAULT_OPTIONS, {
        // after the first candidate has failed, someone takes the other contact's lock: its two touches are busy
        afterCandidate: async () => {
          if (++calls === 1) state.lock = await holdContacts([held.id]);
        },
      });
      expect(report).toMatchObject({
        scanned: 6,
        processed: 1,
        retryScheduled: 1,
        busy: 2,
        waiting: 3,
        conflicts: 0,
        gone: 0,
        created: 0,
      });
      expect(report.scanned).toBe(
        report.processed + report.busy + report.waiting + report.conflicts + report.gone,
      );
      for (const t of [a, h1, h2, ...later]) expect(await linked(t.id)).toBeNull();
    } finally {
      await state.lock?.release();
    }
    // the busy contact is simply handled next run; the waiting one waits for its retry
    expect(await f.run()).toMatchObject({ created: 1, linked: 1, waiting: 0, busy: 0 });
  });

  it("a persistently busy prefix does not stop repeated runs: separate processes of the command reach the eligible work behind it (scan limit smaller than the prefix)", async () => {
    // 8 contacts with the OLDEST touches, all busy for as long as the test holds them; 3 eligible contacts with newer touches
    const busy = [];
    for (let i = 0; i < 8; i++) {
      const c = await addContact(f.t.db, f.w.org.id);
      busy.push({
        c,
        touch: await addTouch(f.t.db, f.w, c.id, { receivedAt: minutesAgo(100 - i) }),
      });
    }
    const eligible = [];
    for (let i = 0; i < 3; i++) {
      const c = await addContact(f.t.db, f.w.org.id);
      eligible.push(await addTouch(f.t.db, f.w, c.id, { receivedAt: minutesAgo(30 - i) }));
    }
    const lock = await holdContacts(busy.map((b) => b.c.id));
    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const cli = () => {
      const r = spawnSync(process.execPath, [tsx, "scripts/leads-reconcile.ts"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          LEADS_RECONCILER_ENABLED: "true",
          DATABASE_URL: f.t.url,
          LEADS_RECONCILE_SCAN_LIMIT: "3", // far fewer than the 8 busy contacts in front
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout.trim()) as {
        created: number;
        busy: number;
        scanned: number;
        remaining: { due: number };
      };
    };
    try {
      // process 1: the three eligible touches are reached although eight busy contacts are older and the scan limit is three
      const first = cli();
      expect(first).toMatchObject({ created: 3, busy: 0, scanned: 3 });
      for (const t of eligible) expect(await linked(t.id)).not.toBeNull();
      // process 2 and 3: nothing can be done while the contacts are busy, and nothing is wasted on them
      for (let i = 0; i < 2; i++)
        expect(cli()).toMatchObject({ created: 0, scanned: 0, busy: 0, remaining: { due: 8 } });
    } finally {
      await lock.release();
    }
    // free: the next processes make steady progress through the previously busy contacts, three at a time
    expect(cli()).toMatchObject({ created: 3, remaining: { due: 5 } });
    expect(cli()).toMatchObject({ created: 3, remaining: { due: 2 } });
    expect(cli()).toMatchObject({ created: 2, remaining: { due: 0 } });
    for (const b of busy) expect(await linked(b.touch.id)).not.toBeNull();
    expect(await count("leads")).toBe(11);
  }, 180_000);

  it("a prefix held back by the first-touch policy (many later touches of a contact whose earlier touch is in its back-off) does not use up the scan either", async () => {
    const held = await addContact(f.t.db, f.w.org.id);
    const earlier = await addTouch(f.t.db, f.w, held.id, { receivedAt: minutesAgo(100) });
    await f.q(
      "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour', 'pg_p0001')",
      [f.w.org.id, earlier.id, held.id],
    );
    for (let i = 0; i < 20; i++)
      await addTouch(f.t.db, f.w, held.id, { receivedAt: minutesAgo(90 - i) });
    const eligible = [];
    for (let i = 0; i < 3; i++)
      eligible.push(
        await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
          receivedAt: minutesAgo(30 - i),
        }),
      );
    const report = await f.run({ scanLimit: 3, pageSize: 2 });
    expect(report).toMatchObject({ scanned: 3, created: 3, waiting: 0, busy: 0 });
    for (const t of eligible) expect(await linked(t.id)).not.toBeNull();
    expect(report.remaining.due).toBe(20);
  });

  it("touches whose rows are locked by a writer outside the contract are passed over at once as busy and the run still reaches the work behind them", async () => {
    const locked = [];
    for (let i = 0; i < 3; i++) {
      const c = await addContact(f.t.db, f.w.org.id);
      locked.push(await addTouch(f.t.db, f.w, c.id, { receivedAt: minutesAgo(60 - i) }));
    }
    const eligible = [];
    for (let i = 0; i < 3; i++)
      eligible.push(
        await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
          receivedAt: minutesAgo(30 - i),
        }),
      );
    const rogue = await f.t.pool.connect();
    try {
      await rogue.query("begin");
      await rogue.query("select id from lead_attributions where id = any($1) for update", [
        locked.map((t) => t.id),
      ]);
      const started = Date.now();
      const report = await f.run();
      expect(Date.now() - started).toBeLessThan(2_500); // three busy touches would have cost 9 s if they were waited for
      expect(report).toMatchObject({ busy: 3, created: 3, waiting: 0 });
      expect(report.scanned).toBe(
        report.processed + report.busy + report.waiting + report.conflicts + report.gone,
      );
      await rogue.query("commit");
    } finally {
      await rogue.query("rollback").catch(() => undefined);
      rogue.release();
    }
    expect(await f.run()).toMatchObject({ created: 3 });
  });

  it("the scan's busy test uses the SAME key as the lead writers: a lock taken by the application's own lock function hides the contact", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const held = await holdContacts([contact.id]); // contactLockKey is the application's own key function
    try {
      expect(await f.run()).toMatchObject({ scanned: 0, processed: 0, remaining: { due: 1 } });
    } finally {
      await held.release();
    }
    expect((await f.run()).created).toBe(1);
  });
});

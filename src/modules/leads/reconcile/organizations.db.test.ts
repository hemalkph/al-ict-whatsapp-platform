import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeMemberRole, reactivateMember, suspendMember } from "@/modules/access";
import { contactLockKey } from "../locks";
import { world, type World } from "../testing";
import { candidateQuery, scanCandidates } from "./scan";
import { DEFAULT_OPTIONS } from "./config";
import { runReconciliation } from "./run";
import {
  addContact,
  addTouch,
  fixture,
  minutesAgo,
  waitUntilBlocked,
  type Fixture,
} from "./testing";

// Staff management holds an organization row FOR UPDATE for the length of its transaction, which makes every attempt on that
// organization busy. Third review, M3: the candidate SCAN itself asks PostgreSQL for the organization row FOR KEY SHARE ... SKIP
// LOCKED, so a busy organization's touches are never returned and never use up the scan limit, however many organizations are busy
// and with no state kept between runs. These tests use the REAL suspension, demotion and reactivation services (a real service
// transaction holds the organization row, and is kept waiting on a membership row that the test holds, so the overlap is
// deterministic) and separate processes of the real command.

type Kind = "suspend" | "demote" | "reactivate";

describe("lead reconciler: an organization held by staff management does not starve the others", () => {
  let f: Fixture;
  let holds = 0;
  const open: Array<{ release: () => Promise<unknown> }> = [];
  beforeEach(async () => {
    f = await fixture();
    holds = 0;
  });
  afterEach(async () => {
    for (const h of open.splice(0)) await h.release().catch(() => undefined);
    await f.close();
  });

  const deps = () => ({ db: f.t.db });

  /**
   * Starts the REAL service for the organization of `w` and keeps it inside its transaction (the organization row held FOR UPDATE,
   * waiting for a membership row the test holds). release() lets it finish and returns whether it succeeded.
   */
  async function holdOrganization(w: World, kind: Kind) {
    const target = kind === "demote" ? w.staff : w.viewer;
    if (kind === "reactivate")
      await f.q("update organization_memberships set status = 'SUSPENDED' where id = $1", [
        target.membershipId,
      ]);
    const blocker = await f.t.pool.connect();
    await blocker.query("begin");
    await blocker.query("select id from organization_memberships where id = $1 for update", [
      target.membershipId,
    ]);
    const service: Promise<unknown> =
      kind === "suspend"
        ? suspendMember(w.admin.ctx, { membershipId: target.membershipId }, deps())
        : kind === "demote"
          ? changeMemberRole(
              w.admin.ctx,
              { membershipId: target.membershipId, role: "VIEWER" },
              deps(),
            )
          : reactivateMember(w.admin.ctx, { membershipId: target.membershipId }, deps());
    const outcome = service.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    holds++;
    await waitUntilBlocked(f.t, holds);
    let released = false;
    const hold = {
      async release() {
        if (released) return { ok: true as const };
        released = true;
        await blocker.query("commit");
        blocker.release();
        holds--;
        return outcome;
      },
    };
    open.push(hold);
    return hold;
  }

  async function addOrg(touches: number, minutesOld: number) {
    const w = await world(f.t.db);
    const made = [];
    for (let i = 0; i < touches; i++) {
      const contact = await addContact(f.t.db, w.org.id);
      made.push(
        await addTouch(f.t.db, w, contact.id, { receivedAt: minutesAgo(minutesOld - i * 0.1) }),
      );
    }
    return { w, touches: made };
  }

  const linked = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const count = async (sql: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`)).n;

  const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const cli = (scanLimit: number) => {
    const r = spawnSync(process.execPath, [tsx, "scripts/leads-reconcile.ts"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        LEADS_RECONCILER_ENABLED: "true",
        DATABASE_URL: f.t.url,
        LEADS_RECONCILE_SCAN_LIMIT: String(scanLimit),
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.trim();
    // counts only: no identifier of an organization, a contact, a touch or a message can appear
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    return JSON.parse(out) as {
      fetched: number;
      scanned: number;
      created: number;
      busy: number;
      errors: Record<string, number>;
      remaining: { due: number };
    };
  };

  it.each(["suspend", "demote", "reactivate"] as const)(
    "the REAL %s service holds organization A; separate command runs with a scan limit of 3 still reach organization B, and A's touches progress once it is released",
    async (kind) => {
      // four OLDER touches in organization A, three NEWER ones in organization B; the scan limit is smaller than A's prefix
      const a = await addOrg(4, 100);
      const b = await addOrg(3, 30);
      const hold = await holdOrganization(a.w, kind);

      const first = cli(3);
      expect(first).toMatchObject({ created: 3, scanned: 3, busy: 0, fetched: 3, errors: {} });
      for (const t of b.touches) expect(await linked(t.id)).not.toBeNull();
      for (const t of a.touches) expect(await linked(t.id)).toBeNull();

      // further runs while A stays busy: nothing to do, nothing wasted, nothing waited for
      const started = Date.now();
      for (let i = 0; i < 2; i++)
        expect(cli(3)).toMatchObject({
          created: 0,
          scanned: 0,
          busy: 0,
          fetched: 0,
          remaining: { due: 4 },
          errors: {},
        });
      expect(Date.now() - started).toBeLessThan(45_000);

      // the management transaction commits (the REAL service succeeded: no deadlock, no lost write)
      expect(await hold.release()).toEqual({ ok: true });
      expect(await count("lead_events where kind = 'CREATED'")).toBe(3);

      // A is available again: its touches progress, three at a time
      expect(cli(3)).toMatchObject({ created: 3, remaining: { due: 1 } });
      expect(cli(3)).toMatchObject({ created: 1, remaining: { due: 0 }, errors: {} });
      for (const t of a.touches) expect(await linked(t.id)).not.toBeNull();
      expect(await count("leads")).toBe(7);
      // exactly one open lead per contact: no duplicate creation
      expect(
        await count(
          "(select contact_id from leads where closed_at is null group by contact_id having count(*) > 1) d",
        ),
      ).toBe(0);
    },
    240_000,
  );

  it("several organizations at once: two busy (suspension and demotion), one with a busy contact, one free: the free work runs, nothing is lost, the others finish later", async () => {
    const a = await addOrg(2, 100);
    const b = await addOrg(2, 90);
    const c = await addOrg(3, 80);
    const free = await addOrg(2, 20);
    const holdA = await holdOrganization(a.w, "suspend");
    const holdB = await holdOrganization(b.w, "demote");
    // organization C has one contact whose advisory lock is taken by another writer
    const lockHolder = await f.t.pool.connect();
    await lockHolder.query("begin");
    await lockHolder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      contactLockKey(c.w.org.id, c.touches[0]!.contactId),
    ]);
    try {
      const during = await runReconciliation(f.t.db, { ...DEFAULT_OPTIONS, scanLimit: 3 });
      expect(during).toMatchObject({ created: 3, busy: 0 });
      expect(during.errors).toEqual({});
      // the older touches of C (two of its three: the third contact's lock is held) and the first of the free organization were
      // handled; A and B are skipped by the scan itself
      expect(await count("leads")).toBe(3);
      for (const t of [...a.touches, ...b.touches]) expect(await linked(t.id)).toBeNull();
      expect(await linked(free.touches[0]!.id)).not.toBeNull();
    } finally {
      await lockHolder.query("commit");
      lockHolder.release();
    }
    expect(await holdA.release()).toEqual({ ok: true });
    expect(await holdB.release()).toEqual({ ok: true });
    for (let i = 0; i < 3; i++)
      await runReconciliation(f.t.db, { ...DEFAULT_OPTIONS, scanLimit: 3 });
    expect(await count("leads")).toBe(9);
    expect(
      await count(
        "(select contact_id from leads where closed_at is null group by contact_id having count(*) > 1) d",
      ),
    ).toBe(0);
  }, 120_000);

  it("two reconcilers at once with an organization held: each skips it, the other organization's touches are created exactly once, no deadlock", async () => {
    const a = await addOrg(3, 100);
    const b = await addOrg(4, 30);
    const hold = await holdOrganization(a.w, "suspend");
    const reports = await Promise.all([
      runReconciliation(f.t.db, { ...DEFAULT_OPTIONS, scanLimit: 5 }),
      runReconciliation(f.t.db, { ...DEFAULT_OPTIONS, scanLimit: 5 }),
    ]);
    expect(reports[0]!.created + reports[1]!.created).toBe(4);
    for (const r of reports) {
      expect(r.errors).toEqual({});
      expect(r.conflicts).toBe(0);
    }
    expect(await count("leads")).toBe(4);
    for (const t of b.touches) expect(await linked(t.id)).not.toBeNull();
    for (const t of a.touches) expect(await linked(t.id)).toBeNull();
    expect(await hold.release()).toEqual({ ok: true });
  }, 120_000);

  it("an organization that turns busy AFTER the scan: its attempts are busy (revalidated under the lock, nothing is waited for), the run goes on, the next run finishes it", async () => {
    const a = await addOrg(3, 100);
    const b = await addOrg(2, 30);
    const state: { hold?: Awaited<ReturnType<typeof holdOrganization>> } = {};
    let calls = 0;
    const report = await runReconciliation(
      f.t.db,
      { ...DEFAULT_OPTIONS },
      {
        // after A's FIRST touch was created, staff management takes A's organization row
        afterCandidate: async () => {
          if (++calls === 1) state.hold = await holdOrganization(a.w, "suspend");
        },
      },
    );
    expect(report).toMatchObject({
      created: 3, // A's first touch, then B's two
      busy: 2, // A's other two touches: found busy by their own attempts, one attempt each
    });
    expect(report.errors).toEqual({});
    expect(report.scanned).toBe(
      report.processed + report.busy + report.waiting + report.conflicts + report.gone,
    );
    for (const t of b.touches) expect(await linked(t.id)).not.toBeNull();
    expect(await state.hold!.release()).toEqual({ ok: true });
    // organization free between runs: the next run finishes A
    expect(await runReconciliation(f.t.db, { ...DEFAULT_OPTIONS })).toMatchObject({ created: 2 });
    expect(await count("leads")).toBe(5);
  }, 120_000);

  it("ORIGINAL REPRODUCTION: 101 busy organizations, scan limit 1, eligible work in organization 102: independent runs reach it, no token, no stored cursor, no limit on busy organizations", async () => {
    const busy = [];
    for (let i = 0; i < 101; i++) busy.push(await addOrg(1, 200 - i * 0.5));
    const later = await addOrg(2, 10);
    // 101 organizations held FOR UPDATE by one session, like staff management would (the real services are used in the tests above)
    const holder = await f.t.pool.connect();
    await holder.query("begin");
    await holder.query("select id from organizations where id = any($1) for update", [
      busy.map((o) => o.w.org.id),
    ]);
    try {
      const first = cli(1);
      // before the fix: fetched 101, scanned 1, created 0, on every run
      expect(first).toMatchObject({ fetched: 1, scanned: 1, created: 1, busy: 0, errors: {} });
      const second = cli(1);
      expect(second).toMatchObject({ fetched: 1, scanned: 1, created: 1, errors: {} });
      for (const t of later.touches) expect(await linked(t.id)).not.toBeNull();
      for (const o of busy) expect(await linked(o.touches[0]!.id)).toBeNull();
      // nothing left that the busy organizations do not hold: the run ends quietly, without waiting
      expect(cli(1)).toMatchObject({ fetched: 0, scanned: 0, created: 0, remaining: { due: 101 } });
    } finally {
      await holder.query("commit");
      holder.release();
    }
    // released: the previously excluded touches progress (one per run with this scan limit)
    expect(cli(1)).toMatchObject({ created: 1, remaining: { due: 100 } });
    expect(await count("leads")).toBe(3);
  }, 240_000);

  it("the scan holds only organization row locks, only while it runs: no attribution, lead, decision or contact row and no advisory lock is held, and nothing is kept after it ends", async () => {
    const a = await addOrg(2, 20);
    const b = await addOrg(1, 10);
    const orgs = [a.w.org.id, b.w.org.id];
    const returned = await scanCandidates(f.t.db, null, 10, DEFAULT_OPTIONS);
    expect(returned).toHaveLength(3);
    const attributionIds = returned.map((c) => c.attributionId);
    const contactIds = returned.map((c) => c.contactId);
    // can ANOTHER session lock these rows exclusively right now, without waiting?
    const lockable = async (sql: string, params: unknown[]) => {
      const c = await f.t.pool.connect();
      try {
        await c.query("begin");
        await c.query(sql, params);
        await c.query("rollback");
        return "lockable";
      } catch (error) {
        await c.query("rollback").catch(() => undefined);
        return (error as { code?: string }).code ?? "error";
      } finally {
        c.release();
      }
    };
    // while a scan transaction is open (the statement ran, the transaction has not ended)
    await f.t.db.transaction(async (tx) => {
      await tx.execute(candidateQuery(null, 10, DEFAULT_OPTIONS));
      // the organization rows of the candidates are held: a writer that needs them exclusively would have to wait (NOWAIT: 55P03)
      expect(
        await lockable("select id from organizations where id = any($1) for update nowait", [orgs]),
      ).toBe("55P03");
      // NOTHING else is held
      expect(
        await lockable("select id from lead_attributions where id = any($1) for update nowait", [
          attributionIds,
        ]),
      ).toBe("lockable");
      expect(
        await lockable("select id from contacts where id = any($1) for update nowait", [
          contactIds,
        ]),
      ).toBe("lockable");
      expect(await lockable("select id from leads for update nowait", [])).toBe("lockable");
      expect(
        await lockable("select attribution_id from lead_reconcile_decisions for update nowait", []),
      ).toBe("lockable");
      const advisory = await tx.execute<{ n: number }>(
        sql`select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
      );
      expect(advisory.rows[0]!.n).toBe(0);
    });
    // after the scan: the organization rows are free again
    expect(
      await lockable("select id from organizations where id = any($1) for update nowait", [orgs]),
    ).toBe("lockable");
  });

  it("the actual scan statement skips busy organizations BEFORE the limit and keeps the order: (received_at, id), tenant by tenant", async () => {
    const a = await addOrg(4, 100); // older, busy
    const b = await addOrg(3, 50);
    const c = await addOrg(2, 20);
    const rogue = await f.t.pool.connect();
    await rogue.query("begin");
    await rogue.query("select id from organizations where id = $1 for update", [a.w.org.id]);
    try {
      const page1 = await scanCandidates(f.t.db, null, 3, DEFAULT_OPTIONS);
      expect(page1.map((x) => x.attributionId)).toEqual(b.touches.map((t) => t.id)); // full page, all of B, none of A
      const last = page1[page1.length - 1]!;
      const page2 = await scanCandidates(
        f.t.db,
        { t: last.receivedKey, id: last.attributionId },
        3,
        DEFAULT_OPTIONS,
      );
      expect(page2.map((x) => x.attributionId)).toEqual(c.touches.map((t) => t.id));
      expect(page2.every((x) => x.organizationId === c.w.org.id)).toBe(true);
    } finally {
      await rogue.query("commit");
      rogue.release();
    }
    // released: A's older touches lead the order again
    const after = await scanCandidates(f.t.db, null, 4, DEFAULT_OPTIONS);
    expect(after.map((x) => x.attributionId)).toEqual(a.touches.map((t) => t.id));
  });

  it("no cross-tenant leakage: a busy organization's touches are never examined, and the reports carry counts only", async () => {
    const a = await addOrg(2, 100);
    const b = await addOrg(1, 30);
    const hold = await holdOrganization(a.w, "suspend");
    const report = await runReconciliation(f.t.db, { ...DEFAULT_OPTIONS });
    expect(JSON.stringify(report)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    expect(report).toMatchObject({ created: 1, scanned: 1 });
    // only B's lead exists, and it belongs to B's organization
    expect(await count(`leads where organization_id = '${b.w.org.id}'`)).toBe(1);
    expect(await count(`leads where organization_id = '${a.w.org.id}'`)).toBe(0);
    expect(await hold.release()).toEqual({ ok: true });
  });
});

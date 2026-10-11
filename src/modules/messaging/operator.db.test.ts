import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { REPO } from "@/modules/whatsapp/worker/testing";
import { dispatchBatch, claimNext, recoverStuck } from "./dispatch";
import {
  inspectOutbound,
  listOutbound,
  listTemplates,
  outboundCounts,
  outboundHealth,
  registerTemplate,
  runOutboundCli,
  setTemplateStatus,
} from "./operator";
import { SENDING_RECOVERY_AFTER_MS } from "./policy";
import { submitOutboundMessage } from "./submit";
import { FakeTransport, ON, addTemplate, minutesAgo, textInput, world } from "./testing";

// Read-only outbound diagnostics, template registration and the command line, on real PostgreSQL.

const SECRET_BODY = "SECRET-OUTBOUND-BODY-TEXT";

describe("outbound operator tooling", () => {
  let t: TestDb;
  let clock = new Date();
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    clock = new Date();
    await t.pool.query("delete from outbound_requests");
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });

  const queue = async (x: Awaited<ReturnType<typeof world>>, body = SECRET_BODY, key?: string) =>
    submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, body, key), {
      db: t.db as never,
      config: ON,
      now: () => clock,
    });
  const deps = (transport: FakeTransport) => ({
    db: t.db as never,
    transport,
    config: ON,
    now: () => clock,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
  });

  it("counts requests by state and reason, and lists them without bodies or recipients", async () => {
    const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
    await queue(x, SECRET_BODY, "op-key-0000001");
    const held = await world(t.db, { lastInboundAt: minutesAgo(5) });
    await queue(held);
    await t.db
      .update((await import("@/db")).schema.whatsappAccounts)
      .set({ status: "DISABLED" })
      .where(
        (await import("drizzle-orm")).eq(
          (await import("@/db")).schema.whatsappAccounts.id,
          held.account.id,
        ),
      );
    await dispatchBatch(deps(new FakeTransport().acceptAll()), {});
    const counts = await outboundCounts(t.db as never);
    expect(counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "ACCEPTED", count: 1 }),
        expect.objectContaining({ state: "HELD", reason: "account_inactive", count: 1 }),
      ]),
    );
    const list = await listOutbound(t.db as never, { limit: 10 });
    expect(list).toHaveLength(2);
    const text = JSON.stringify(list);
    for (const leak of [SECRET_BODY, x.contact.waId!, held.contact.waId!])
      expect(text).not.toContain(leak);
    expect(list.every((r) => r.recipientKind === "PHONE")).toBe(true);
    expect(await listOutbound(t.db as never, { state: "HELD" })).toHaveLength(1);
  });

  it("inspect shows state, reasons and a hashed provider id, with advice for UNKNOWN_OUTCOME, and never the body or recipient", async () => {
    const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
    const r = await queue(x);
    await dispatchBatch(
      deps(
        new FakeTransport().next({ kind: "unknown", reason: "send_deadline", httpStatus: null }),
      ),
      {},
    );
    const view = await inspectOutbound(t.db as never, r.requestId);
    expect(view).toMatchObject({
      ok: true,
      request: {
        state: "UNKNOWN_OUTCOME",
        failureCode: "send_deadline",
        recipientKind: "PHONE",
        providerMessageIdHash: null,
      },
    });
    expect((view as { next: string }).next).toMatch(/never be re-sent automatically/);
    expect(JSON.stringify(view)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(view)).not.toContain(x.contact.waId!);
    const accepted = await queue(x, "again", "op-key-0000002");
    await dispatchBatch(
      deps(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.HASHME",
          providerStatus: null,
          httpStatus: 200,
        }),
      ),
      {},
    );
    const acceptedView = (await inspectOutbound(t.db as never, accepted.requestId)) as {
      request: { providerMessageIdHash: string };
    };
    expect(acceptedView.request.providerMessageIdHash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(acceptedView)).not.toContain("wamid.HASHME");
    expect(await inspectOutbound(t.db as never, "nope")).toMatchObject({ ok: false });
    expect(
      await inspectOutbound(t.db as never, "00000000-0000-4000-8000-000000000009"),
    ).toMatchObject({ refused: "not_found" });
  });

  describe("health", () => {
    it("an empty system has no findings", async () => {
      expect((await outboundHealth(t.db as never, clock)).findings).toEqual([]);
    });

    it("UNKNOWN_OUTCOME and stuck sends need attention; held and rejected are informational", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, "a", "op-key-0000003");
      await dispatchBatch(
        deps(
          new FakeTransport().next({
            kind: "unknown",
            reason: "transport_error_after_possible_send",
            httpStatus: null,
          }),
        ),
        {},
      );
      await queue(x, "b", "op-key-0000004");
      const { claim } = await claimNext(deps(new FakeTransport()));
      expect(claim).not.toBeNull();
      const later = new Date(clock.getTime() + 3 * 60_000);
      const health = await outboundHealth(t.db as never, later);
      expect(health.findings.map((f) => f.code)).toEqual(
        expect.arrayContaining(["unknown_outcome_requests", "stuck_sending"]),
      );
      expect(health.needsAttention).toBe(true);
      expect(JSON.stringify(health)).not.toContain(x.contact.waId!);
    });

    it("a queue that is not draining is reported only when due work is old and nothing was sent recently", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, "old", "op-key-0000005");
      const later = new Date(clock.getTime() + 10 * 60_000);
      expect((await outboundHealth(t.db as never, later)).findings.map((f) => f.code)).toContain(
        "queue_not_draining",
      );
      expect(
        (await outboundHealth(t.db as never, clock)).findings.map((f) => f.code),
      ).not.toContain("queue_not_draining");
    });

    it("accepted messages without a delivery status and orphan statuses are listed as pending reconciliation (information)", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, "acc", "op-key-0000006");
      await dispatchBatch(
        deps(
          new FakeTransport().next({
            kind: "accepted",
            wamid: "wamid.NOSTATUS",
            providerStatus: null,
            httpStatus: 200,
          }),
        ),
        {},
      );
      const health = await outboundHealth(t.db as never, new Date(clock.getTime() + 30 * 60_000));
      expect(health.reconciliation.acceptedWithoutDeliveryStatus).toBe(1);
      expect(
        health.findings.find((f) => f.code === "status_reconciliation_pending")?.severity,
      ).toBe("info");
    });

    it("recovered UNKNOWN requests are counted, and the health report never offers a resend", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, "z", "op-key-0000007");
      await claimNext(deps(new FakeTransport()));
      clock = new Date(clock.getTime() + SENDING_RECOVERY_AFTER_MS + 1000);
      await recoverStuck(deps(new FakeTransport()));
      const health = await outboundHealth(t.db as never, clock);
      expect(health.states).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "UNKNOWN_OUTCOME",
            reason: "process_died_after_dispatch_start",
          }),
        ]),
      );
      expect(JSON.stringify(health)).not.toMatch(/resend|retry now|requeue/i);
    });
  });

  describe("templates", () => {
    it("registering is a dry run by default, creates PENDING_ATTESTATION (not sendable), and approval needs an explicit attestation", async () => {
      const x = await world(t.db);
      const input = {
        accountId: x.account.id,
        name: "order_update",
        language: "en_US",
        category: "UTILITY",
        bodyParameters: 1,
      };
      expect(await registerTemplate(t.db as never, input, false)).toMatchObject({
        ok: true,
        applied: false,
      });
      expect(
        (await listTemplates(t.db as never)).filter((tpl) => tpl.accountId === x.account.id),
      ).toEqual([]);
      const done = await registerTemplate(t.db as never, input, true);
      expect(done).toMatchObject({ ok: true, applied: true, status: "PENDING_ATTESTATION" });
      expect(await registerTemplate(t.db as never, input, true)).toMatchObject({
        ok: false,
        refused: "already_registered",
      });
      const [tpl] = (await listTemplates(t.db as never)).filter(
        (r) => r.accountId === x.account.id,
      );
      expect(tpl).toMatchObject({
        status: "PENDING_ATTESTATION",
        attestedAt: null,
        bodyParameters: 1,
      });
      expect(
        await setTemplateStatus(
          t.db as never,
          { templateId: tpl!.id, to: "APPROVED", attested: false },
          true,
        ),
      ).toMatchObject({ refused: "attestation_required" });
      expect((await listTemplates(t.db as never)).find((r) => r.id === tpl!.id)!.status).toBe(
        "PENDING_ATTESTATION",
      );
      expect(
        await setTemplateStatus(
          t.db as never,
          { templateId: tpl!.id, to: "APPROVED", attested: true },
          false,
        ),
      ).toMatchObject({ applied: false });
      expect((await listTemplates(t.db as never)).find((r) => r.id === tpl!.id)!.status).toBe(
        "PENDING_ATTESTATION",
      );
      expect(
        await setTemplateStatus(
          t.db as never,
          { templateId: tpl!.id, to: "APPROVED", attested: true },
          true,
        ),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      expect(
        (await listTemplates(t.db as never)).find((r) => r.id === tpl!.id)!.attestedAt,
      ).not.toBeNull();
      expect(
        await setTemplateStatus(
          t.db as never,
          { templateId: tpl!.id, to: "DISABLED", attested: false },
          true,
        ),
      ).toMatchObject({ ok: true, status: "DISABLED" });
    });

    it("rejects malformed names, languages, categories and unknown accounts; the organization comes from the account", async () => {
      const x = await world(t.db);
      const ok = {
        accountId: x.account.id,
        name: "n",
        language: "en",
        category: "UTILITY",
        bodyParameters: 0,
      };
      for (const bad of [
        { name: "Has Capitals" },
        { name: "" },
        { language: "english" },
        { category: "PROMO" },
        { bodyParameters: 21 },
        { bodyParameters: -1 },
        { accountId: "x" },
      ])
        expect(
          await registerTemplate(t.db as never, { ...ok, ...bad }, true),
          JSON.stringify(bad),
        ).toMatchObject({ ok: false, refused: "invalid_input" });
      expect(
        await registerTemplate(
          t.db as never,
          { ...ok, accountId: "00000000-0000-4000-8000-000000000005" },
          true,
        ),
      ).toMatchObject({ refused: "account_not_found" });
      await registerTemplate(t.db as never, ok, true);
      expect(
        (await listTemplates(t.db as never)).find((tpl) => tpl.accountId === x.account.id),
      ).toMatchObject({ organization: x.org.slug });
    });

    it("a template registered here is only usable by staff after attestation", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const pending = await addTemplate(t.db, x, { status: "PENDING_ATTESTATION" });
      await expect(
        submitOutboundMessage(
          x.actor.ctx,
          {
            idempotencyKey: "tpl-op-key-001",
            conversationId: x.conversation.id,
            message: { type: "template", templateId: pending.id, parameters: [] },
          },
          { db: t.db as never, config: ON },
        ),
      ).rejects.toMatchObject({ reason: "template_not_approved" });
    });
  });

  describe("command line", () => {
    const capture = () => {
      const out: unknown[] = [];
      return { out, fn: (v: unknown) => void out.push(v) };
    };

    it("usage errors exit 2 and touch nothing; there is no resend or resolve command", async () => {
      for (const argv of [
        [],
        ["bogus"],
        ["resend", "x"],
        ["resolve", "x"],
        ["list", "--state", "NOPE"],
        ["list", "--nope"],
        ["templates"],
      ]) {
        const c = capture();
        expect(
          await runOutboundCli(
            argv,
            new Proxy(
              {},
              {
                get() {
                  throw new Error("db touched");
                },
              },
            ) as never,
            c.fn,
          ),
          JSON.stringify(argv),
        ).toBe(2);
        expect(JSON.stringify(c.out[0])).toContain("usage");
      }
    });

    it("health --check exits 1 when something needs attention", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, "u", "op-key-0000008");
      await dispatchBatch(
        {
          ...deps(
            new FakeTransport().next({
              kind: "unknown",
              reason: "send_deadline",
              httpStatus: null,
            }),
          ),
          now: () => new Date(),
        },
        {},
      );
      const c = capture();
      expect(await runOutboundCli(["health", "--check"], t.db as never, c.fn)).toBe(1);
      expect(c.out[0]).toMatchObject({ ok: true, needsAttention: true });
    });

    it("the real script prints exactly one JSON document and no body, recipient or secret", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      await queue(x, SECRET_BODY, "op-key-0000009");
      const run = (args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "scripts/whatsapp-outbound.ts", ...args],
            {
              cwd: REPO,
              env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DATABASE_URL: t.url },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.stderr.on("data", (d) => (stderr += d));
          child.on("exit", (code) => resolve({ code, stdout, stderr }));
        });
      for (const args of [["counts"], ["list"], ["health"], ["templates", "list"]]) {
        const r = await run(args);
        expect(r.code, args.join(" ")).toBe(0);
        expect(() => JSON.parse(r.stdout)).not.toThrow();
        for (const leak of [SECRET_BODY, x.contact.waId!])
          expect(r.stdout + r.stderr).not.toContain(leak);
      }
      expect((await run(["nonsense"])).code).toBe(2);
    }, 60_000);
  });
});

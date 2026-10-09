import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { ingestBytes } from "../identity/testing";
import { deliveryBytes } from "../inbound/testing";
import { insertEvent } from "../queue/testing";
import { REPO } from "../worker/testing";

// The REAL operator scripts as child processes. Contract: stdout is exactly ONE parseable JSON document (the command's
// result); audit and diagnostic log lines go to stderr; privacy rules hold on both streams.

const SECRET_TEXT = "SECRET-STUDENT-MESSAGE-TEXT";

describe("operator scripts: stdout is one JSON document, logs go to stderr", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });

  type Result = { code: number | null; stdout: string; stderr: string };
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<Result>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
        cwd: REPO,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DATABASE_URL: t.url, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  /** stdout must be ONE JSON document: JSON.parse rejects two documents or any stray log line. */
  const one = (r: Result) => JSON.parse(r.stdout) as Record<string, unknown>;
  const stderrEvents = (r: Result) =>
    r.stderr
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  async function org(slug: string) {
    const o = await seedOrg(t.db);
    await t.pool.query("update organizations set slug = $2 where id = $1", [o.id, slug]);
  }
  const register = (extra: string[] = ["--apply"]) =>
    run("whatsapp-accounts.ts", [
      "register",
      "--organization",
      "alpha",
      "--waba-id",
      "200000000000001",
      "--phone-number-id",
      "100000000000001",
      "--display-phone-number",
      "+94 77 000 0001",
      "--confirm-single-portfolio",
      ...extra,
    ]);

  it("a successful account mutation: one JSON document on stdout, the audit event on stderr", async () => {
    await org("alpha");
    const registered = await register();
    expect(registered.code).toBe(0);
    const doc = one(registered);
    expect(doc).toMatchObject({ ok: true, applied: true, account: { status: "PENDING" } });
    expect(stderrEvents(registered).map((e) => e.webhook_event)).toContain(
      "operator.account_registered",
    );
    expect(registered.stdout).not.toContain("operator.account_registered");

    const id = (doc.account as { id: string }).id;
    const activated = await run("whatsapp-accounts.ts", ["activate", id, "--apply"]);
    expect(activated.code).toBe(0);
    expect(one(activated)).toMatchObject({ ok: true, account: { status: "ACTIVE" } });
    expect(stderrEvents(activated).map((e) => e.webhook_event)).toContain(
      "operator.account_activated",
    );
  });

  it("a dry run: one JSON document, no audit event (nothing happened)", async () => {
    await org("alpha");
    const dry = await register([]);
    expect(dry.code).toBe(0);
    expect(one(dry)).toMatchObject({ applied: false, dryRun: true });
    expect(stderrEvents(dry)).toEqual([]);
  });

  it("a successful held-event operation: one JSON document, the requeue event on stderr", async () => {
    await org("alpha");
    const reg = one(await register()) as { account: { id: string } };
    const id = reg.account.id;
    await run("whatsapp-accounts.ts", ["activate", id, "--apply"]);
    await run("whatsapp-accounts.ts", ["disable", id, "--apply"]);
    await ingestBytes(
      t.db,
      deliveryBytes({ id: "wamid.HELD", bsuid: "LK.H", text: undefined } as never).bytes,
    );
    await run("whatsapp-accounts.ts", ["enable", id, "--apply"]);
    const preview = await run("whatsapp-events.ts", [
      "requeue-routed",
      "--account",
      id,
      "--reason",
      "account_disabled",
    ]);
    expect(one(preview)).toMatchObject({ applied: false, wouldRequeueOrRequeued: 1 });
    const applied = await run("whatsapp-events.ts", [
      "requeue-routed",
      "--account",
      id,
      "--reason",
      "account_disabled",
      "--apply",
      "--expect",
      "1",
    ]);
    expect(applied.code).toBe(0);
    expect(one(applied)).toMatchObject({ ok: true, applied: true, wouldRequeueOrRequeued: 1 });
    expect(stderrEvents(applied).map((e) => e.webhook_event)).toContain("operator.events_requeued");
  });

  describe("DEAD events", () => {
    const dead = () =>
      insertEvent(t.db, {
        status: "DEAD",
        lastError: "invalid_timestamp",
        attempts: 1,
        payload: {
          v: 1,
          field: "messages",
          message: { type: "text", text: { body: SECRET_TEXT } },
        },
      });

    it("inspection: one JSON document, payload hidden on both streams", async () => {
      const e = await dead();
      const r = await run("whatsapp-events.ts", ["dead", "inspect", e.id]);
      expect(r.code).toBe(0);
      expect(one(r)).toMatchObject({ ok: true, event: { category: "invalid_provider_payload" } });
      expect(r.stdout).not.toContain(SECRET_TEXT);
      expect(r.stderr).not.toContain(SECRET_TEXT);
      expect(stderrEvents(r)).toEqual([]);
    });

    it("--reveal-payload without the opt-in: refused (exit 1), one JSON document, no payload on either stream", async () => {
      const e = await dead();
      const refusedEnvs: Record<string, string>[] = [
        {},
        { WHATSAPP_ALLOW_PII_REVEAL: "false" },
        { WHATSAPP_ALLOW_PII_REVEAL: "TRUE" },
        { WHATSAPP_ALLOW_PII_REVEAL: "1" },
      ];
      for (const env of refusedEnvs) {
        const r = await run(
          "whatsapp-events.ts",
          ["dead", "inspect", e.id, "--reveal-payload"],
          env,
        );
        expect(r.code).toBe(1);
        expect(one(r)).toMatchObject({ ok: false, refused: "pii_reveal_disabled" });
        expect(r.stdout).not.toContain(SECRET_TEXT);
        expect(r.stderr).not.toContain(SECRET_TEXT);
        expect(stderrEvents(r).map((x) => x.webhook_event)).toEqual([
          "operator.payload_reveal_refused",
        ]);
        for (const value of Object.values(env))
          expect(r.stdout + r.stderr).not.toContain(`"${value}"`);
      }
      // the same command without --reveal-payload still works with the variable unset
      const plain = await run("whatsapp-events.ts", ["dead", "inspect", e.id]);
      expect(plain.code).toBe(0);
      expect(one(plain)).toMatchObject({ ok: true });
    });

    it("explicit reveal with WHATSAPP_ALLOW_PII_REVEAL=true: the payload is on stdout (one document); the audit event is on stderr and never carries it", async () => {
      const e = await dead();
      const r = await run("whatsapp-events.ts", ["dead", "inspect", e.id, "--reveal-payload"], {
        WHATSAPP_ALLOW_PII_REVEAL: "true",
      });
      expect(r.code).toBe(0);
      expect(JSON.stringify(one(r))).toContain(SECRET_TEXT);
      const events = stderrEvents(r);
      expect(events.map((x) => x.webhook_event)).toEqual(["operator.payload_revealed"]);
      expect(events[0]).toMatchObject({ webhook_event_id: e.id });
      expect(r.stderr).not.toContain(SECRET_TEXT);
    });
  });

  describe("error exits", () => {
    it("a refusal (exit 1) still prints exactly one JSON document and nothing else on stdout", async () => {
      const r = await run("whatsapp-accounts.ts", [
        "activate",
        "00000000-0000-4000-8000-000000000000",
        "--apply",
      ]);
      expect(r.code).toBe(1);
      expect(one(r)).toMatchObject({ ok: false, refused: "account_not_found" });
    });

    it("a usage error (exit 2) prints one JSON document", async () => {
      for (const script of ["whatsapp-accounts.ts", "whatsapp-events.ts"]) {
        const r = await run(script, ["nonsense"]);
        expect(r.code).toBe(2);
        expect(one(r)).toMatchObject({ ok: false, usage: expect.any(Array) });
      }
      const status = await run("whatsapp-status.ts", ["--bogus"]);
      expect(status.code).toBe(2);
      expect(one(status)).toMatchObject({ ok: false });
    });

    it("an unexpected failure (exit 1) leaves stdout empty and explains on stderr, without the connection string", async () => {
      const r = await run("whatsapp-status.ts", [], {
        DATABASE_URL: "postgresql://admin:Sup3rSecretPw@127.0.0.1:1/none",
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Command failed unexpectedly");
      expect(r.stderr).not.toContain("Sup3rSecretPw");
    });

    it("status --check: one JSON document and a non-zero exit when attention is needed", async () => {
      await insertEvent(t.db, { status: "DEAD", lastError: "invalid_timestamp", attempts: 1 });
      const r = await run("whatsapp-status.ts", ["--check"]);
      expect(r.code).toBe(1);
      expect(one(r)).toMatchObject({ ok: true, needsAttention: true });
    });
  });
});

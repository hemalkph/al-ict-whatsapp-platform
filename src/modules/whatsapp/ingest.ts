import { eq } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { sha256Hex } from "./idempotency";
import { normalizeEnvelope, type NormalizedEvent } from "./normalize";
import { parseDelivery } from "./parse";
import { decideRouting, lookupAccounts, type AccountLookup, type RoutingDecision } from "./routing";

// Persists one SIGNATURE-VERIFIED delivery. Order of durability:
//   1. the exact bytes go into webhook_requests first (together with ingest_status);
//   2. only then are routing and the per-item webhook_events derived and inserted.
// Nothing here creates contacts, conversations, messages or statuses, calls an external service, or schedules work.
//
// Failure policy (ADR 0013):
//   * the raw bytes cannot be stored, or any infrastructure error (connection loss, deadlock, serialization failure,
//     timeout): the error propagates and the caller answers 500, so Meta retries and nothing is lost;
//   * a DETERMINISTIC problem with the signed content (SQLSTATE class 22 or 23, or the pure normalizer throwing): the
//     request row is kept, marked EVENTS_REJECTED, no child events survive, and the caller answers 200, because
//     retrying the same bytes could never succeed.

const CHUNK = 500;

export type EventCounts = {
  events: number;
  inserted: number;
  duplicates: number;
  pending: number;
  held: number;
  ignored: number;
  dead: number;
};

export type IngestOutcome = {
  requestId: string;
  ingestStatus: "ACCEPTED" | "UNPARSEABLE" | "UNSUPPORTED_SHAPE" | "EVENTS_REJECTED";
  ingestErrorCode: string | null;
  counts: EventCounts;
};

export type IngestDeps = {
  db?: Database;
  /** Test seam; production uses the real whatsapp_accounts lookup. */
  lookupAccounts?: AccountLookup;
};

const noCounts = (): EventCounts => ({
  events: 0,
  inserted: 0,
  duplicates: 0,
  pending: 0,
  held: 0,
  ignored: 0,
  dead: 0,
});

type Executor = Pick<Database, "insert" | "update">;

async function insertRequest(
  db: Executor,
  body: Uint8Array,
  sha: string,
  ingestStatus: IngestOutcome["ingestStatus"],
  ingestErrorCode: string | null,
): Promise<string> {
  const [row] = await db
    .insert(schema.webhookRequests)
    .values({
      rawBody: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      payloadSha256: sha,
      ingestStatus,
      ingestErrorCode,
    })
    .returning({ id: schema.webhookRequests.id });
  if (!row) throw new Error("webhook_requests insert returned no row");
  return row.id;
}

/** SQLSTATE of a (possibly wrapped) database error, or null when it is not a PostgreSQL error. */
export function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The same signed bytes would fail the same way on every redelivery, so answering 500 (and inviting 7 days of retries)
 * would only create a poison loop: a data exception (22xxx), an integrity constraint violation (23xxx), a program
 * limit such as "stack depth limit exceeded" for absurdly nested JSON (54xxx), or the JavaScript RangeError that very
 * deep nesting causes. Connection loss, deadlocks, serialization failures, timeouts and resource exhaustion are NOT here.
 */
export function isDeterministicDataError(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const state = sqlState(error);
  return (
    state !== null && (state.startsWith("22") || state.startsWith("23") || state.startsWith("54"))
  );
}

type Row = { event: NormalizedEvent; decision: RoutingDecision };

async function insertEvents(
  tx: Pick<Database, "insert">,
  requestId: string,
  rows: readonly Row[],
): Promise<EventCounts> {
  const counts = noCounts();
  counts.events = rows.length;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const inserted = await tx
      .insert(schema.webhookEvents)
      .values(
        chunk.map(({ event, decision }) => ({
          requestId,
          organizationId: decision.organizationId,
          whatsappAccountId: decision.whatsappAccountId,
          eventType: event.eventType,
          providerObjectId: event.providerObjectId,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          status: decision.status,
          lastError: decision.reason,
        })),
      )
      .onConflictDoNothing({ target: schema.webhookEvents.idempotencyKey })
      .returning({ status: schema.webhookEvents.status });
    counts.inserted += inserted.length;
    for (const row of inserted) {
      if (row.status === "PENDING") counts.pending++;
      else if (row.status === "UNROUTABLE") counts.held++;
      else if (row.status === "IGNORED") counts.ignored++;
      else if (row.status === "DEAD") counts.dead++;
    }
  }
  counts.duplicates = counts.events - counts.inserted;
  return counts;
}

export async function ingestVerifiedDelivery(
  body: Uint8Array,
  deps: IngestDeps = {},
): Promise<IngestOutcome> {
  const db = deps.db ?? getDb();
  const sha = sha256Hex(body);

  const parsed = parseDelivery(body);
  if (!parsed.ok) {
    const requestId = await insertRequest(db, body, sha, parsed.status, parsed.code);
    return {
      requestId,
      ingestStatus: parsed.status,
      ingestErrorCode: parsed.code,
      counts: noCounts(),
    };
  }

  let events: NormalizedEvent[];
  try {
    events = normalizeEnvelope(parsed.envelope);
  } catch {
    // The normalizer is a pure function of the signed bytes: it would throw again on every redelivery.
    const requestId = await insertRequest(db, body, sha, "EVENTS_REJECTED", "normalize_failed");
    return {
      requestId,
      ingestStatus: "EVENTS_REJECTED",
      ingestErrorCode: "normalize_failed",
      counts: noCounts(),
    };
  }

  return db.transaction(async (tx) => {
    const requestId = await insertRequest(tx, body, sha, "ACCEPTED", null);
    if (events.length === 0) {
      return {
        requestId,
        ingestStatus: "ACCEPTED" as const,
        ingestErrorCode: null,
        counts: noCounts(),
      };
    }

    const phoneNumberIds = [
      ...new Set(events.flatMap((e) => (e.phoneNumberId ? [e.phoneNumberId] : []))),
    ];
    const accounts = await (deps.lookupAccounts ?? lookupAccounts)(tx, phoneNumberIds);

    // The same logical item twice in one delivery is one event.
    const unique = new Map<string, NormalizedEvent>();
    for (const event of events)
      if (!unique.has(event.idempotencyKey)) unique.set(event.idempotencyKey, event);
    const rows: Row[] = [...unique.values()].map((event) => ({
      event,
      decision: decideRouting(event, accounts),
    }));

    try {
      // A savepoint: if the children fail deterministically they vanish, the request row (inserted above) does not.
      const counts = await tx.transaction((sp) => insertEvents(sp, requestId, rows));
      counts.events = events.length;
      counts.duplicates = events.length - counts.inserted;
      return { requestId, ingestStatus: "ACCEPTED" as const, ingestErrorCode: null, counts };
    } catch (error) {
      if (!isDeterministicDataError(error)) throw error; // infrastructure failure: roll everything back, answer 500
      await tx
        .update(schema.webhookRequests)
        .set({ ingestStatus: "EVENTS_REJECTED", ingestErrorCode: "event_insert_data_error" })
        .where(eq(schema.webhookRequests.id, requestId));
      return {
        requestId,
        ingestStatus: "EVENTS_REJECTED" as const,
        ingestErrorCode: "event_insert_data_error",
        counts: noCounts(),
      };
    }
  });
}

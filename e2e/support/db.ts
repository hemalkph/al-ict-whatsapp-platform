import { Pool } from "pg";

// Assertions against the disposable E2E database ("is the DB session really gone?"). Writes belong to the application under
// test, never to the tests; the only exceptions are the two labelled "arrange" helpers at the end of this file.

let pool: Pool | undefined;

function getPool(): Pool {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set. Run with `npm run test:e2e`.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || !/\/al_ict_e2e_/.test(url)) {
    throw new Error("Refusing to touch anything but a local al_ict_e2e_* database.");
  }
  return (pool ??= new Pool({ connectionString: url, max: 2 }));
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await getPool().query(sql, params);
  if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}.`);
  return rows[0] as T;
}

export const sessionCount = async (email: string) =>
  (
    await one<{ n: number }>(
      "select count(*)::int n from sessions s join users u on u.id = s.user_id where u.email = $1",
      [email],
    )
  ).n;

export const passwordChangeRequired = async (email: string) =>
  (
    await one<{ required: boolean }>(
      `select coalesce((select password_change_required from user_security_state ss where ss.user_id = u.id), false) required
         from users u where u.email = $1`,
      [email],
    )
  ).required;

export const membershipOf = (email: string) =>
  one<{ id: string; organization_id: string; role: string; status: string }>(
    `select m.id, m.organization_id, m.role, m.status
       from organization_memberships m join users u on u.id = m.user_id where u.email = $1`,
    [email],
  );

export const userExists = async (email: string) =>
  (await one<{ n: number }>("select count(*)::int n from users where email = $1", [email])).n > 0;

export const userCount = async () =>
  (await one<{ n: number }>("select count(*)::int n from users", [])).n;

/** A stored webhook delivery found by the SHA-256 of its exact bytes (read-only assertions). */
export const webhookDelivery = async (sha256: string) =>
  (
    await getPool().query<{
      raw_body: Buffer;
      ingest_status: string;
      ingest_error_code: string | null;
      events: number;
      event_status: string | null;
      event_reason: string | null;
    }>(
      `select r.raw_body, r.ingest_status, r.ingest_error_code,
              (select count(*)::int from webhook_events e where e.request_id = r.id) as events,
              (select e.status from webhook_events e where e.request_id = r.id limit 1) as event_status,
              (select e.last_error from webhook_events e where e.request_id = r.id limit 1) as event_reason
         from webhook_requests r where r.payload_sha256 = $1`,
      [sha256],
    )
  ).rows;

// ----------------------------------------------------------------------------------------------- inbox (read-only)
async function many<T>(sql: string, params: unknown[]): Promise<T[]> {
  const { rows } = await getPool().query(sql, params);
  return rows as T[];
}

/** The seeded conversation of a fake contact, found by profile name. */
export const conversationIdFor = async (profileName: string) =>
  (
    await one<{ id: string }>(
      `select c.id from conversations c join contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
        where ct.profile_name = $1`,
      [profileName],
    )
  ).id;

export const outboundRequestsFor = (conversationId: string) =>
  many<{ state: string; recipient_kind: string; message_type: string }>(
    "select state, recipient_kind, message_type from outbound_requests where conversation_id = $1 order by created_at",
    [conversationId],
  );

export const conversationState = (conversationId: string) =>
  one<{
    status: string;
    assigned_membership_id: string | null;
    last_inbound_at: Date | null;
    last_outbound_at: Date | null;
  }>(
    "select status, assigned_membership_id, last_inbound_at, last_outbound_at from conversations where id = $1",
    [conversationId],
  );

export const noteCount = async (conversationId: string) =>
  (
    await one<{ n: number }>(
      "select count(*)::int n from conversation_notes where conversation_id = $1",
      [conversationId],
    )
  ).n;

export const messageCount = async (conversationId: string) =>
  (
    await one<{ n: number }>("select count(*)::int n from messages where conversation_id = $1", [
      conversationId,
    ])
  ).n;

// ---------------------------------------------------------------------------------------------- inbox (arrange helpers)
// The two background processes that do not run in the E2E app are simulated by these helpers, only against the disposable
// database: the inbound worker (a customer message arrives) and the outbound worker (a queued request moves on). The
// assertions about what the application then shows are made through the real UI and API.

/** A customer message arrives now (what the inbound worker would have stored). */
export async function addInboundMessage(conversationId: string, body: string): Promise<string> {
  const { rows } = await getPool().query(
    `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, wamid, occurred_at)
     select c.organization_id, c.id, c.whatsapp_account_id, 'INBOUND', 'TEXT', $2, 'wamid.E2EARR' || gen_random_uuid(), now()
       from conversations c where c.id = $1 returning id`,
    [conversationId, body],
  );
  await getPool().query(
    "update conversations set last_message_at = now(), last_inbound_at = now() where id = $1",
    [conversationId],
  );
  return rows[0].id as string;
}

/** What the outbound worker would have done to the latest request of a conversation. */
export async function forceOutboundState(
  conversationId: string,
  state: "SENDING" | "ACCEPTED" | "REJECTED" | "HELD" | "UNKNOWN_OUTCOME",
) {
  const { rows } = await getPool().query(
    "select id from outbound_requests where conversation_id = $1 order by created_at desc limit 1",
    [conversationId],
  );
  const id = rows[0]?.id as string | undefined;
  if (!id) throw new Error("no outbound request to move");
  const q = (sql: string, params: unknown[] = [id]) => getPool().query(sql, params);
  if (state === "HELD") {
    await q(
      "update outbound_requests set state='HELD', hold_reason='window_closed', finished_at=now() where id=$1",
    );
    return;
  }
  await q(
    "update outbound_requests set state='SENDING', claimed_by='e2e', claimed_at=now(), send_started_at=now() where id=$1",
  );
  if (state === "ACCEPTED")
    await q(
      "update outbound_requests set state='ACCEPTED', accepted_at=now(), finished_at=now() where id=$1",
    );
  if (state === "REJECTED")
    await q(
      "update outbound_requests set state='REJECTED', failure_code='invalid_request', finished_at=now() where id=$1",
    );
  if (state === "UNKNOWN_OUTCOME")
    await q(
      "update outbound_requests set state='UNKNOWN_OUTCOME', failure_code='transport_timeout', finished_at=now() where id=$1",
    );
}

export const seenCount = async (conversationId: string, email: string) =>
  (
    await one<{ n: number }>(
      `select count(*)::int n from message_reads r
         join messages m on m.organization_id = r.organization_id and m.id = r.message_id
         join organization_memberships om on om.organization_id = r.organization_id and om.id = r.membership_id
         join users u on u.id = om.user_id
        where m.conversation_id = $1 and u.email = $2`,
      [conversationId, email],
    )
  ).n;

export const outboundBodies = async (conversationId: string) =>
  await many<{ body: string; idempotency_key: string }>(
    `select m.body, r.idempotency_key from outbound_requests r join messages m on m.id = r.message_id
        where r.conversation_id = $1 order by r.created_at`,
    [conversationId],
  );

/** Outbound requests created by a staff member (any conversation, any organization). */
export const requestsOwnedBy = async (email: string) =>
  (
    await one<{ n: number }>(
      `select count(*)::int n from outbound_requests r
         join organization_memberships om on om.organization_id = r.organization_id and om.id = r.requested_by_membership_id
         join users u on u.id = om.user_id where u.email = $1`,
      [email],
    )
  ).n;

export const outboundMessageCount = async (conversationId: string) =>
  (
    await one<{ n: number }>(
      "select count(*)::int n from messages where conversation_id = $1 and direction = 'OUTBOUND'",
      [conversationId],
    )
  ).n;

/** The three identifiers that scope a pending-send record for a staff member (as the server renders them into the page). */
export const actorIdsOf = (email: string) =>
  one<{ userId: string; organizationId: string; membershipId: string }>(
    `select u.id as "userId", m.organization_id as "organizationId", m.id as "membershipId"
       from organization_memberships m join users u on u.id = m.user_id where u.email = $1`,
    [email],
  );

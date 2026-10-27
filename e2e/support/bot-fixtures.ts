import { Pool, type PoolClient } from "pg";
import { BOT_ORG_A, BOT_ORG_B, BOT_USERS, INBOX_USERS } from "./identities";

/**
 * The seeded account whose stored password hash the bot users copy (all seeded accounts share E2E_PASSWORD, which loginViaUi uses by
 * default). It must be one whose password NO spec changes: e2e/auth.spec.ts changes the first admin's, so copying that hash made the bot
 * sign-in fail whenever the ordinary suite had run that spec first. If the account is missing the insert returns no row and the
 * fixture fails (there is no fallback to another account).
 */
export const PASSWORD_SOURCE = INBOX_USERS.viewer.email;

// TEST-ONLY fixtures for the Inbox bot indicator specs (Phase 08F, e2e/inbox-bot.spec.ts). Plain SQL against the ONE disposable
// al_ict_e2e_<12 hex> database of the run, nothing else:
//  - It imports no production module (the bot, messaging and inbox modules keep their boundaries); every row is written the way any
//    future writer would reach the table, so the DATABASE guards, foreign keys and control-sequence allocation are what decide
//    what is valid. Triggers are never disabled and session_replication_role is never changed (both are checked before writing).
//  - Fake organizations, members, students and messages only. No Meta credential exists: the WhatsApp numbers have none, and the
//    one deployment is PAUSED (it could never start a session) on a server where the bot runtime and sending are off anyway.
//  - Users reuse the stored password hash of the seeded first admin (all seeded accounts share the E2E password), so no password
//    hashing code is duplicated here.
//  - Nothing is cleaned up: the database is dropped by scripts/e2e.ts when the run ends.

// ----------------------------------------------------------------------------------------------------- identity guard
/** The only server the browser E2E may use (the isolated test PostgreSQL container, published on this loopback port). */
export const E2E_HOST = "127.0.0.1";
export const E2E_PORT = 55432;
export const E2E_DATABASE_NAME = /^al_ict_e2e_[0-9a-f]{12}$/;

export type Target = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/** Validates E2E_DATABASE_URL and returns the explicit target (no query string, fragment or PG* fallback can change it). */
export function parseTarget(url: string | undefined): Target {
  if (!url) throw new Error("E2E_DATABASE_URL is not set. Run with `npm run test:e2e`.");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("E2E_DATABASE_URL is not a URL.");
  }
  const database = decodeURIComponent(u.pathname.slice(1));
  const problems = [
    !/^postgres(ql)?:$/.test(u.protocol) && "protocol",
    u.hostname !== E2E_HOST && `host (must be ${E2E_HOST})`,
    Number(u.port) !== E2E_PORT && `port (must be ${E2E_PORT})`,
    (u.search !== "" || u.hash !== "") && "query or fragment",
    !E2E_DATABASE_NAME.test(database) && "database name (must be al_ict_e2e_<12 hex>)",
    !u.username && "user",
  ].filter(Boolean);
  if (problems.length > 0)
    throw new Error(`Refusing to use E2E_DATABASE_URL: bad ${problems.join(", ")}.`);
  return {
    host: u.hostname,
    port: Number(u.port),
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

let pool: Pool | undefined;
let target: Target | undefined;

function getPool(): Pool {
  target ??= parseTarget(process.env.E2E_DATABASE_URL);
  return (pool ??= new Pool({ ...target, max: 2 })); // explicit fields: exactly what was validated is what connects
}

export async function closeBotDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** What the CONNECTION itself reports, checked before the first write: the exact generated database, PostgreSQL 17.x, guards on. */
async function assertIdentity(c: PoolClient): Promise<void> {
  const { rows } = await c.query<{
    db: string;
    version: string;
    role: string;
    guards: string;
  }>(
    `select current_database() db, current_setting('server_version_num') version,
            current_setting('session_replication_role') role,
            (select count(*) from pg_trigger where tgenabled = 'O' and tgname in (
               'bot_sessions_a_guard_trg', 'bot_sessions_b_allocate_insert_trg', 'bot_sessions_b_allocate_handover_trg',
               'bot_deployments_guard_trg', 'bot_versions_guard_trg', 'bots_guard_trg',
               'outbound_requests_guard_trg', 'outbound_requests_allocate_control_seq_trg'))::text guards`,
  );
  const r = rows[0]!;
  const version = Number(r.version);
  const problems = [
    r.db !== target?.database && "database differs from the validated target",
    !E2E_DATABASE_NAME.test(r.db) && "database name",
    !(version >= 170000 && version < 180000) && "server is not PostgreSQL 17.x",
    r.role !== "origin" && "session_replication_role is not origin",
    r.guards !== "8" && `only ${r.guards} of 8 guard triggers are enabled`,
  ].filter(Boolean);
  if (problems.length > 0)
    throw new Error(`Refusing to write bot fixtures: ${problems.join("; ")}.`);
}

// ---------------------------------------------------------------------------------------------------------- the plan
// Pure data: what the database will hold and what a staff member should see. The expectations are written by hand here and are
// never derived from the production display code, so the specs compare the screen with an independent statement.

/** Values that must never reach any response: session variables, captured input and tokens. */
export const CANARY = {
  variable: "CANARY-VARIABLE-VALUE-7f3a",
  awaiting: "CANARY-AWAITING-PROMPT-9b21",
  /** Every session's awaiting token starts with this (see sessionToken); tests look for the prefix. */
  tokenPrefix: "CANARYTOKEN",
} as const;

/**
 * The n-th session's token: 22 characters of [A-Za-z0-9_-], the shape the database requires, and distinct for every n. Migration 0007
 * makes (organization_id, awaiting_token) unique for non-null tokens, so no two sessions of the fixture may share one.
 */
export const sessionToken = (n: number): string =>
  `${CANARY.tokenPrefix}${String(n).padStart(11, "0")}`;

export type RequestState =
  "QUEUED" | "SENDING" | "ACCEPTED" | "HELD" | "REJECTED" | "UNKNOWN_OUTCOME";
export type MessagePlan = {
  key: string;
  direction: "INBOUND" | "OUTBOUND";
  type: "TEXT" | "INTERACTIVE" | "BUTTON";
  body: string | null;
  content?: unknown;
  /** Key of an earlier message of the same conversation this one replies to. */
  replyTo?: string;
  /** A reply to a message this conversation does not have. */
  replyToWamid?: string;
  /** An origin-BOT request for this OUTBOUND message, in its final state (steps are numbered in order). */
  request?: { state: RequestState; holdReason?: string; failureCode?: string };
};
export type SessionPlan = {
  end: "LIVE" | "COMPLETED" | "HANDED_OVER" | "FAILED";
  /** HANDED_OVER only. The six flow codes mean "flow_handover"; any other code is a system handover. */
  handoverReason?: string;
  /** Key of the message whose request is this session's terminal notice (COMPLETED or flow-HANDED_OVER). */
  noticeOf?: string;
  redacted?: boolean;
};
export type ConversationPlan = {
  key: string;
  org: "A" | "B";
  /** The profile name: unique, no underscore. */
  name: string;
  status?: "OPEN" | "RESOLVED";
  /** Sessions oldest first; only the LAST can be live and only the last owns the messages' requests. */
  sessions: SessionPlan[];
  messages?: MessagePlan[];
  minutesAgo: number;
  expect: {
    /** The label of the latest session, or null when the conversation has no bot history. */
    label: string | null;
    warning: boolean;
    /** In the Bot attention view (unresolved and the latest session HANDED_OVER or FAILED). */
    attention: boolean;
    /** Shown on the conversation row (not for a quiet COMPLETED session). */
    inList: boolean;
    /** Texts the details panel shows. */
    details: string[];
    /** Texts it must not show. */
    notDetails?: string[];
  };
};

export const FLOW_HANDOVER_CODES = [
  "student_requested",
  "needs_staff",
  "out_of_scope",
  "invalid_input",
  "error_fallback",
  "other",
] as const;

const REPLY_ID = (key: string) => `b1.AAAAAAAAAAAAAAAAAAAAAA.${key}`;
const buttons = (body: string, titles: string[]) => ({
  interactive: {
    v: 1,
    kind: "buttons",
    body,
    buttons: titles.map((title, i) => ({ id: REPLY_ID(`opt${i}`), title })),
  },
});
const MAY_NOT_HAVE = "The student may not have received the bot's last message";
const noticeConversation = (
  key: string,
  name: string,
  end: "COMPLETED" | "HANDED_OVER",
  state: RequestState,
  minutesAgo: number,
  notice: string,
  warning: boolean,
): ConversationPlan => ({
  key,
  org: "A",
  name,
  minutesAgo,
  sessions: [
    {
      end,
      noticeOf: "notice",
      ...(end === "HANDED_OVER" ? { handoverReason: "needs_staff" } : {}),
    },
  ],
  messages: [
    {
      key: "notice",
      direction: "OUTBOUND",
      type: "TEXT",
      body: "Thank you, a team member will reply soon.",
      request: {
        state,
        ...(state === "HELD" ? { holdReason: "bot_session_ended" } : {}),
        ...(state === "REJECTED" ? { failureCode: "meta_rejected" } : {}),
      },
    },
  ],
  expect: {
    label: end === "COMPLETED" ? "Bot finished" : "Bot asked for a human",
    warning,
    attention: end === "HANDED_OVER",
    inList: end === "HANDED_OVER" || warning,
    details: [notice],
  },
});

/** How many extra unresolved HANDED_OVER conversations push the Bot attention view past one page of 30. */
export const BULK_ATTENTION = 25;
const bulk: ConversationPlan[] = Array.from({ length: BULK_ATTENTION }, (_, i) => ({
  key: `bulk${i + 1}`,
  org: "A" as const,
  name: `Bot Bulk ${String(i + 1).padStart(2, "0")}`,
  minutesAgo: 100 + i,
  sessions: [{ end: "HANDED_OVER" as const, handoverReason: "needs_staff" }],
  expect: {
    label: "Bot asked for a human",
    warning: false,
    attention: true,
    inList: true,
    details: [],
  },
}));
/** The newest conversations of the organization are NOT in the Bot attention view, so a filter applied after paging would show gaps. */
const quiet: ConversationPlan[] = [1, 2, 3].map((n) => ({
  key: `quiet${n}`,
  org: "A" as const,
  name: `Bot Quiet ${n}`,
  minutesAgo: n,
  sessions: [{ end: "LIVE" as const }],
  expect: {
    label: "Bot is handling this chat",
    warning: false,
    attention: false,
    inList: true,
    details: [],
  },
}));

export const BOT_CONVERSATIONS: ConversationPlan[] = [
  ...quiet,
  {
    key: "handling",
    org: "A",
    name: "Bot Handling Amaya",
    minutesAgo: 10,
    sessions: [{ end: "LIVE" }],
    expect: {
      label: "Bot is handling this chat",
      warning: false,
      attention: false,
      inList: true,
      details: [],
    },
  },
  {
    key: "finished",
    org: "A",
    name: "Bot Finished Bimal",
    minutesAgo: 11,
    sessions: [{ end: "COMPLETED" }],
    expect: { label: "Bot finished", warning: false, attention: false, inList: false, details: [] },
  },
  {
    key: "askedHuman",
    org: "A",
    name: "Bot Asked Chamari",
    minutesAgo: 12,
    sessions: [{ end: "HANDED_OVER", handoverReason: "needs_staff" }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: true,
      inList: true,
      details: ["The flow said a staff member is needed", "The bot flow"],
      notDetails: [MAY_NOT_HAVE],
    },
  },
  {
    key: "systemHandover",
    org: "A",
    name: "Bot System Dinesh",
    minutesAgo: 13,
    sessions: [{ end: "HANDED_OVER", handoverReason: "staff_assigned" }],
    expect: {
      label: "Bot handed over to staff",
      warning: false,
      attention: true,
      inList: true,
      details: ["A staff member was assigned", "The system"],
      notDetails: [MAY_NOT_HAVE],
    },
  },
  {
    key: "failed",
    org: "A",
    name: "Bot Failed Eranga",
    minutesAgo: 14,
    sessions: [{ end: "FAILED" }],
    expect: {
      label: "Bot stopped with an error",
      warning: true,
      attention: true,
      inList: true,
      details: [],
    },
  },
  {
    key: "botError",
    org: "A",
    name: "Bot Error Farah",
    minutesAgo: 15,
    sessions: [{ end: "HANDED_OVER", handoverReason: "bot_error" }],
    expect: {
      label: "Bot handed over to staff",
      warning: true,
      attention: true,
      inList: true,
      details: ["The bot hit an internal error"],
      notDetails: [MAY_NOT_HAVE],
    },
  },
  {
    key: "sendHeld",
    org: "A",
    name: "Bot SendHeld Gayan",
    minutesAgo: 16,
    sessions: [{ end: "HANDED_OVER", handoverReason: "send_held" }],
    expect: {
      label: "Bot handed over to staff",
      warning: true,
      attention: true,
      inList: true,
      details: ["A bot message was held and not sent", MAY_NOT_HAVE],
    },
  },
  {
    key: "resolvedHandover",
    org: "A",
    name: "Bot Resolved Hiran",
    status: "RESOLVED",
    minutesAgo: 17,
    sessions: [{ end: "HANDED_OVER", handoverReason: "needs_staff" }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: false,
      inList: true,
      details: [],
    },
  },
  {
    key: "latestCompleted",
    org: "A",
    name: "Bot Latest Completed Isuri",
    minutesAgo: 18,
    sessions: [{ end: "HANDED_OVER", handoverReason: "staff_replied" }, { end: "COMPLETED" }],
    expect: { label: "Bot finished", warning: false, attention: false, inList: false, details: [] },
  },
  {
    key: "latestHandover",
    org: "A",
    name: "Bot Latest Handover Janaka",
    minutesAgo: 19,
    sessions: [{ end: "COMPLETED" }, { end: "HANDED_OVER", handoverReason: "student_requested" }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: true,
      inList: true,
      details: [],
    },
  },
  {
    key: "toResolve",
    org: "A",
    name: "Bot ToResolve Kumari",
    minutesAgo: 20,
    sessions: [{ end: "HANDED_OVER", handoverReason: "needs_staff" }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: true,
      inList: true,
      details: [],
    },
  },
  noticeConversation(
    "noticeQueued",
    "Bot Notice Queued Lasith",
    "HANDED_OVER",
    "QUEUED",
    21,
    "The final message has not been confirmed yet",
    false,
  ),
  noticeConversation(
    "noticeSending",
    "Bot Notice Sending Mahesh",
    "HANDED_OVER",
    "SENDING",
    22,
    "The final message has not been confirmed yet",
    false,
  ),
  noticeConversation(
    "noticeAccepted",
    "Bot Notice Accepted Nadee",
    "HANDED_OVER",
    "ACCEPTED",
    23,
    "The final message was accepted by WhatsApp",
    false,
  ),
  noticeConversation(
    "noticeHeld",
    "Bot Notice Held Oshan",
    "HANDED_OVER",
    "HELD",
    24,
    "The final message was held and not sent",
    true,
  ),
  noticeConversation(
    "noticeRejected",
    "Bot Notice Rejected Pavithra",
    "HANDED_OVER",
    "REJECTED",
    25,
    "WhatsApp rejected the final message",
    true,
  ),
  noticeConversation(
    "noticeUnknown",
    "Bot Notice Unknown Rukshan",
    "HANDED_OVER",
    "UNKNOWN_OUTCOME",
    26,
    "The final message may or may not have been sent",
    true,
  ),
  noticeConversation(
    "noticeCompletedRejected",
    "Bot Notice Completed Sachini",
    "COMPLETED",
    "REJECTED",
    27,
    "WhatsApp rejected the final message",
    true,
  ),
  {
    key: "redacted",
    org: "A",
    name: "Bot Redacted Tharindu",
    minutesAgo: 28,
    sessions: [{ end: "HANDED_OVER", handoverReason: "needs_staff", redacted: true }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: true,
      inList: true,
      details: ["This session's stored details were redacted."],
    },
  },
  {
    key: "holds",
    org: "A",
    name: "Bot Holds Udari",
    minutesAgo: 29,
    sessions: [{ end: "HANDED_OVER", handoverReason: "staff_replied" }],
    messages: [
      {
        key: "h1",
        direction: "OUTBOUND",
        type: "TEXT",
        body: "Held bot text one",
        request: { state: "HELD", holdReason: "staff_took_over" },
      },
      {
        key: "h2",
        direction: "OUTBOUND",
        type: "TEXT",
        body: "Held bot text two",
        request: { state: "HELD", holdReason: "bot_step_superseded" },
      },
      {
        key: "h3",
        direction: "OUTBOUND",
        type: "TEXT",
        body: "Held bot text three",
        request: { state: "HELD", holdReason: "bot_stopped" },
      },
    ],
    expect: {
      label: "Bot handed over to staff",
      warning: false,
      attention: true,
      inList: true,
      details: [],
    },
  },
  {
    key: "interactive",
    org: "A",
    name: "Bot Interactive Viraj",
    minutesAgo: 30,
    sessions: [{ end: "LIVE" }],
    messages: [
      {
        key: "m2",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: "Would you like to enrol in the A/L ICT class?",
        content: buttons("Would you like to enrol in the A/L ICT class?", ["Yes enrol", "Not now"]),
        request: { state: "ACCEPTED" },
      },
      { key: "m3", direction: "INBOUND", type: "INTERACTIVE", body: "Yes enrol", replyTo: "m2" },
      {
        key: "m4",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: "Choose a class day",
        content: {
          interactive: {
            v: 1,
            kind: "list",
            body: "Choose a class day",
            buttonLabel: "Days",
            sections: [
              {
                title: "Days",
                rows: [
                  { id: REPLY_ID("sat"), title: "Saturday" },
                  { id: REPLY_ID("sun"), title: "Sunday" },
                ],
              },
            ],
          },
        },
        request: { state: "ACCEPTED" },
      },
      { key: "m5", direction: "INBOUND", type: "INTERACTIVE", body: null, replyTo: "m4" },
      // malformed or bodyless interactive messages: they must still read as interactive messages, never as raw JSON or "undefined"
      {
        key: "m6",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: null,
        content: { interactive: { buttons: "not-a-list" } },
        request: { state: "ACCEPTED" },
      },
      { key: "m7", direction: "INBOUND", type: "TEXT", body: "ok thanks", replyTo: "m6" },
      {
        key: "m8",
        direction: "INBOUND",
        type: "TEXT",
        body: "Which day was that?",
        replyToWamid: "wamid.E2EBOTMISSING",
      },
      {
        key: "m9",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: "Pick one",
        content: {
          interactive: {
            sections: [
              { rows: "bad" },
              "x",
              { rows: [{ title: "Alpha" }, { id: "no-title" }, null] },
            ],
          },
        },
        request: { state: "ACCEPTED" },
      },
      // The platform never sends a BUTTON message; this stored row is hostile data, labelled "Unsupported message".
      { key: "m10", direction: "OUTBOUND", type: "BUTTON", body: null, content: null },
    ],
    expect: {
      label: "Bot is handling this chat",
      warning: false,
      attention: false,
      inList: true,
      details: [],
    },
  },
  {
    key: "previewBodyless",
    org: "A",
    name: "Bot Preview Bodyless Wasana",
    minutesAgo: 31,
    sessions: [{ end: "LIVE" }],
    messages: [
      {
        key: "p1",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: null,
        content: { interactive: { sections: 7 } },
        request: { state: "ACCEPTED" },
      },
    ],
    expect: {
      label: "Bot is handling this chat",
      warning: false,
      attention: false,
      inList: true,
      details: [],
    },
  },
  {
    key: "previewReply",
    org: "A",
    name: "Bot Preview Reply Yasas",
    minutesAgo: 32,
    sessions: [{ end: "LIVE" }],
    messages: [
      {
        key: "r1",
        direction: "OUTBOUND",
        type: "INTERACTIVE",
        body: "Are you ready?",
        content: buttons("Are you ready?", ["Ready"]),
        request: { state: "ACCEPTED" },
      },
      { key: "r2", direction: "INBOUND", type: "INTERACTIVE", body: null, replyTo: "r1" },
    ],
    expect: {
      label: "Bot is handling this chat",
      warning: false,
      attention: false,
      inList: true,
      details: [],
    },
  },
  ...bulk,
  {
    key: "orgB",
    org: "B",
    name: "Bot OrgB Zainab",
    minutesAgo: 5,
    sessions: [{ end: "HANDED_OVER", handoverReason: "needs_staff" }],
    expect: {
      label: "Bot asked for a human",
      warning: false,
      attention: true,
      inList: true,
      details: [],
    },
  },
];

/** The hold wording the specs expect for the `holds` conversation (independent of display.ts). */
export const HOLD_WORDING = {
  h1: "Not sent: a staff member took over this conversation.",
  h2: "Not sent: the bot had already moved on.",
  h3: "Not sent: an operator stopped the bot.",
} as const;

/** Plan-derived: the conversations of organization A that belong in the Bot attention view. */
export const attentionKeys = (org: "A" | "B" = "A") =>
  BOT_CONVERSATIONS.filter((c) => c.org === org && c.expect.attention).map((c) => c.key);

// ------------------------------------------------------------------------------------------------------- the writer
export type BotWorld = {
  orgIds: { A: string; B: string };
  users: Record<keyof typeof BOT_USERS, { email: string; membershipId: string }>;
  /** Conversation id by plan key. */
  conversations: Record<string, string>;
};

let counter = 0;

/** Creates the whole world in ONE transaction (a failure leaves nothing behind) after proving the connection's identity. */
export async function createBotWorld(): Promise<BotWorld> {
  const c = await getPool().connect();
  try {
    await c.query("begin");
    await assertIdentity(c);
    const world = await writeBotWorld(c);
    await c.query("commit");
    return world;
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** The one method of a client the writer uses. */
export type Queryable = Pick<PoolClient, "query">;

const id = async (q: Queryable, text: string, params: unknown[]): Promise<string> => {
  const { rows } = await q.query(text, params);
  if (rows.length !== 1)
    throw new Error(`Bot fixture: expected one row from: ${text.slice(0, 60)}`);
  return (rows[0] as { id: string }).id;
};

/** The whole write, against any client (exported so database-free tests can drive it with a recording client). */
export async function writeBotWorld(c: Queryable): Promise<BotWorld> {
  const orgIds = {
    A: await id(c, "insert into organizations (name, slug) values ($1, $2) returning id", [
      BOT_ORG_A.name,
      BOT_ORG_A.slug,
    ]),
    B: await id(c, "insert into organizations (name, slug) values ($1, $2) returning id", [
      BOT_ORG_B.name,
      BOT_ORG_B.slug,
    ]),
  };

  const users = {} as BotWorld["users"];
  for (const key of Object.keys(BOT_USERS) as (keyof typeof BOT_USERS)[]) {
    const u = BOT_USERS[key];
    const userId = await id(
      c,
      `insert into users (name, email, email_verified) select $1::text, $2::text, s.email_verified from users s where s.email = $3 returning id`,
      [u.name, u.email, PASSWORD_SOURCE],
    );
    await id(
      c,
      `insert into accounts (account_id, provider_id, user_id, password)
       select $1::text, 'credential', $2::uuid, a.password from accounts a join users s on s.id = a.user_id
        where s.email = $3 and a.provider_id = 'credential' returning id`,
      [userId, userId, PASSWORD_SOURCE],
    );
    const membershipId = await id(
      c,
      "insert into organization_memberships (organization_id, user_id, role, status) values ($1, $2, $3, 'ACTIVE') returning id",
      [orgIds[u.org], userId, u.role],
    );
    users[key] = { email: u.email, membershipId };
  }

  // One WhatsApp number per organization. No credential reference: nothing could ever be sent from either.
  const accounts = {
    A: await account(c, orgIds.A, "A"),
    B: await account(c, orgIds.B, "B"),
  };

  // Each organization owns its own bot, published version and PAUSED deployment (the sessions need a deployment; PAUSED never starts
  // one). The composite foreign keys tie a session's bot, version and deployment to its own organization, so none is shared.
  const creators = { A: users.admin, B: users.orgB };
  const bundles = {
    A: await botBundle(c, orgIds.A, accounts.A, creators.A.membershipId),
    B: await botBundle(c, orgIds.B, accounts.B, creators.B.membershipId),
  };
  let tokens = 0;

  const world: BotWorld = { orgIds, users, conversations: {} };
  const redact: string[] = [];
  for (const plan of BOT_CONVERSATIONS) {
    const org = orgIds[plan.org];
    const ctx = {
      org,
      account: accounts[plan.org],
      ...bundles[plan.org],
      nextToken: () => sessionToken(++tokens),
    };
    await writeConversation(c, world, plan, ctx, redact);
  }
  if (redact.length > 0) await redactSessions(c, redact);
  return world;
}

async function botBundle(c: Queryable, org: string, account: string, creatorMembershipId: string) {
  const botId = await id(
    c,
    "insert into bots (organization_id, key, name, created_by_membership_id) values ($1, 'e2e_bot', 'E2E Bot', $2) returning id",
    [org, creatorMembershipId],
  );
  const canonical = '{"schemaVersion":1}'; // never executed: no runtime runs in this suite
  const versionId = await id(
    c,
    `insert into bot_versions (organization_id, bot_id, version_number, schema_version, config, config_canonical, config_sha256, published_by_membership_id)
     values ($1, $2, 1, 1, $3::text::jsonb, $3::text, encode(sha256(convert_to($3::text, 'UTF8')), 'hex'), $4) returning id`,
    [org, botId, canonical, creatorMembershipId],
  );
  const deploymentId = await id(
    c,
    "insert into bot_deployments (organization_id, whatsapp_account_id, bot_id, version_id, priority) values ($1, $2, $3, $4, 1) returning id",
    [org, account, botId, versionId],
  );
  await c.query("update bot_deployments set status = 'PAUSED' where id = $1", [deploymentId]);
  const epoch = Number(
    (await c.query("select send_epoch from bot_deployments where id = $1", [deploymentId])).rows[0]
      .send_epoch,
  );
  return { botId, versionId, deploymentId, epoch };
}

async function account(c: Queryable, org: string, tag: string): Promise<string> {
  return id(
    c,
    `insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status)
     values ($1, $2, $3, $4, 'ACTIVE') returning id`,
    [org, `e2e-bots-waba-${tag}`, `e2e-bots-pn-${tag}`, `+94 77 000 000${tag === "A" ? 1 : 2}`],
  );
}

type Ctx = {
  org: string;
  account: string;
  botId: string;
  versionId: string;
  deploymentId: string;
  epoch: number;
  /** The next session token of the whole fixture (distinct each call). */
  nextToken: () => string;
};

async function writeConversation(
  c: Queryable,
  w: BotWorld,
  plan: ConversationPlan,
  x: Ctx,
  redact: string[],
) {
  const at = (seconds: number) => `now() - interval '${seconds} seconds'`; // integers from the plan only
  const waId = `9477001${String(++counter).padStart(4, "0")}`;
  const contactId = await id(
    c,
    "insert into contacts (organization_id, wa_id, profile_name, first_seen_at, last_seen_at) values ($1, $2, $3, now(), now()) returning id",
    [x.org, waId, plan.name],
  );
  const messages = [
    {
      key: "start",
      direction: "INBOUND",
      type: "TEXT",
      body: "Hello, I have a question about the ICT class",
    } as MessagePlan,
    ...(plan.messages ?? []),
  ];
  const lastAt = plan.minutesAgo * 60;
  const conversationId = await id(
    c,
    `insert into conversations (organization_id, whatsapp_account_id, contact_id, status, last_message_at, last_inbound_at, resolved_at)
     values ($1, $2, $3, $4, ${at(lastAt)}, ${at(lastAt)}, ${plan.status === "RESOLVED" ? at(lastAt) : "null"}) returning id`,
    [x.org, x.account, contactId, plan.status ?? "OPEN"],
  );
  w.conversations[plan.key] = conversationId;

  // messages first (the session names the message that started it); requests follow, once their session exists
  const ids: Record<string, string> = {};
  const wamid = () => `wamid.E2EBOT${String(++counter).padStart(6, "0")}`;
  for (const [i, m] of messages.entries()) {
    const occurred = lastAt + (messages.length - 1 - i); // one second apart, the last one at the conversation's last activity
    ids[m.key] = await id(
      c,
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, content, wamid,
                             reply_to_message_id, reply_to_wamid, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, ${at(occurred)}) returning id`,
      [
        x.org,
        conversationId,
        x.account,
        m.direction,
        m.type,
        m.body,
        m.content === undefined ? null : JSON.stringify(m.content),
        m.direction === "INBOUND" ? wamid() : null,
        m.replyTo ? ids[m.replyTo] : null,
        m.replyToWamid ?? null,
      ],
    );
  }

  for (const [n, s] of plan.sessions.entries()) {
    const sessionId = await id(
      c,
      `insert into bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id, conversation_id,
                                 started_by_message_id, state, current_node_id, variables, awaiting, awaiting_token, last_consumed_token)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'WAITING_FOR_INPUT', 'welcome', $9::jsonb, $10::jsonb, $11, $11) returning id`,
      [
        x.org,
        x.botId,
        x.versionId,
        x.deploymentId,
        x.account,
        contactId,
        conversationId,
        ids.start,
        JSON.stringify({ studentName: CANARY.variable }),
        JSON.stringify({ kind: "buttons", prompt: CANARY.awaiting }),
        x.nextToken(),
      ],
    );
    const last = n === plan.sessions.length - 1;
    let noticeStep: number | null = null;
    let step = 0;
    if (last) {
      for (const m of plan.messages ?? []) {
        if (!m.request) continue;
        step += 1;
        await botRequest(c, x, {
          sessionId,
          conversationId,
          messageId: ids[m.key]!,
          step,
          waId,
          request: m.request,
        });
        if (s.noticeOf === m.key) noticeStep = step;
      }
    }
    if (s.noticeOf && noticeStep === null)
      throw new Error(`Bot fixture ${plan.key}: no request for notice ${s.noticeOf}.`);
    if (s.end !== "LIVE") await endSession(c, sessionId, s, noticeStep);
    if (s.redacted) redact.push(sessionId);
  }
}

/** A BOT request in its FINAL state, moved there one legal step at a time like the dispatcher would (nothing here is sent). */
async function botRequest(
  c: Queryable,
  x: Ctx,
  o: {
    sessionId: string;
    conversationId: string;
    messageId: string;
    step: number;
    waId: string;
    request: NonNullable<MessagePlan["request"]>;
  },
) {
  const key = `bot-${o.sessionId}-${o.step}`;
  const { rows } = await c.query(`select m.type from messages m where m.id = $1`, [o.messageId]);
  const type = (rows[0] as { type: string }).type === "INTERACTIVE" ? "INTERACTIVE" : "TEXT";
  // Far-future next attempt and deadline: even a stray worker would find nothing due in these rows (defense in depth).
  const requestId = await id(
    c,
    `insert into outbound_requests (organization_id, whatsapp_account_id, conversation_id, message_id, idempotency_key, request_fingerprint,
                                    message_type, recipient_kind, recipient_id, payload, origin, bot_session_id, bot_step_seq, bot_send_epoch,
                                    next_attempt_at, dispatch_deadline)
     values ($1, $2, $3, $4, $5, encode(sha256(convert_to($5, 'UTF8')), 'hex'), $6, 'PHONE', $7,
             (select coalesce(m.content -> 'interactive', jsonb_build_object('body', m.body)) from messages m where m.id = $4),
             'BOT', $8, $9, $10, now() + interval '30 days', now() + interval '31 days') returning id`,
    [
      x.org,
      x.account,
      o.conversationId,
      o.messageId,
      key,
      type,
      o.waId,
      o.sessionId,
      o.step,
      x.epoch,
    ],
  );
  const { state, holdReason, failureCode } = o.request;
  const set = (sql: string, params: unknown[] = []) =>
    c.query(`update outbound_requests set ${sql} where id = $${params.length + 1}`, [
      ...params,
      requestId,
    ]);
  if (state === "QUEUED") return;
  if (state === "HELD")
    return void (await set("state = 'HELD', hold_reason = $1, finished_at = now()", [
      holdReason ?? "bot_stopped",
    ]));
  await set(
    "state = 'SENDING', claimed_by = 'e2e-fixture', claimed_at = now(), send_started_at = now()",
  );
  if (state === "ACCEPTED")
    await set("state = 'ACCEPTED', accepted_at = now(), finished_at = now()");
  if (state === "REJECTED")
    await set("state = 'REJECTED', failure_code = $1, finished_at = now()", [
      failureCode ?? "invalid_request",
    ]);
  if (state === "UNKNOWN_OUTCOME")
    await set("state = 'UNKNOWN_OUTCOME', failure_code = 'transport_timeout', finished_at = now()");
}

/** The one live -> terminal update of a session. The database stamps ended_at and allocates the handover control sequence. */
async function endSession(
  c: Queryable,
  sessionId: string,
  s: SessionPlan,
  noticeStep: number | null,
) {
  const flow =
    s.end === "HANDED_OVER" &&
    (FLOW_HANDOVER_CODES as readonly string[]).includes(s.handoverReason ?? "");
  const endReason =
    s.end === "COMPLETED"
      ? "flow_end"
      : s.end === "FAILED"
        ? "error"
        : flow
          ? "flow_handover"
          : "system_handover";
  await c.query(
    `update bot_sessions set state = $2, end_reason = $3, handover_reason = $4, step_seq = coalesce($5, step_seq),
            terminal_notice_step_seq = $5, revision = revision + 1 where id = $1`,
    [sessionId, s.end, endReason, s.end === "HANDED_OVER" ? s.handoverReason : null, noticeStep],
  );
}

/**
 * Redacts the listed (already ended) sessions through the guard's own one-way path. The retention period is a replaceable SQL
 * function (the 08C tests do the same). The schema-qualified ORIGINAL definition is captured first, the period is shortened for
 * these updates, and the captured definition itself is executed to restore it; the restored definition must equal the captured
 * one exactly or the whole fixture transaction fails and rolls back.
 */
const RETENTION_FUNCTION = "public.bot_session_redaction_after()";
async function redactSessions(c: Queryable, ids: string[]) {
  const definition = async (): Promise<string> => {
    const { rows } = await c.query(
      `select pg_get_functiondef('${RETENTION_FUNCTION}'::regprocedure) def`,
    );
    return (rows[0] as { def: string }).def;
  };
  const original = await definition();
  if (!original.includes("30 days"))
    throw new Error("Bot fixture: unexpected retention definition.");
  const shortened = original.replace("30 days", "0 seconds");
  await c.query(shortened);
  for (const sessionId of ids)
    await c.query(
      `update bot_sessions set variables = '{}'::jsonb, awaiting = null, awaiting_token = null, last_consumed_token = null,
              redacted_at = now() where id = $1`,
      [sessionId],
    );
  await c.query(original);
  if ((await definition()) !== original)
    throw new Error("Bot fixture: the retention function was not restored exactly.");
}

// ------------------------------------------------------------------------------------------- the no-send evidence
export type SendSnapshot = {
  /** Every outbound request of the two bot organizations: id -> state and a digest of the whole row. */
  requests: Record<string, { state: string; digest: string }>;
  outboundMessages: number;
  statusEvents: number;
  sessionsDigest: string;
};

/** Read-only. Scoped to the two bot organizations: other specs run in parallel and queue replies in theirs. */
export async function sendSnapshot(orgIds: string[]): Promise<SendSnapshot> {
  const q = (text: string) => getPool().query(text, [orgIds]);
  const requests: SendSnapshot["requests"] = {};
  for (const r of (
    await q(
      "select id, state, md5(to_jsonb(r)::text) digest from outbound_requests r where organization_id = any($1::uuid[]) order by id",
    )
  ).rows)
    requests[r.id] = { state: r.state, digest: r.digest };
  return {
    requests,
    outboundMessages: (
      await q(
        "select count(*)::int n from messages where organization_id = any($1::uuid[]) and direction = 'OUTBOUND'",
      )
    ).rows[0].n,
    statusEvents: (
      await q(
        "select count(*)::int n from message_status_events where organization_id = any($1::uuid[])",
      )
    ).rows[0].n,
    sessionsDigest: (
      await q(
        "select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by id), '')) d from bot_sessions s where organization_id = any($1::uuid[])",
      )
    ).rows[0].d,
  };
}

/** Empty when browsing changed nothing that could be a send: no new request, no request touched, no new SENDING, no new outbound message. */
export function sendProblems(before: SendSnapshot, after: SendSnapshot): string[] {
  const problems: string[] = [];
  for (const [rid, a] of Object.entries(after.requests)) {
    const b = before.requests[rid];
    if (!b) problems.push(`new outbound request ${rid} (${a.state})`);
    else if (b.digest !== a.digest)
      problems.push(`request ${rid} changed: ${b.state} -> ${a.state}`);
    if (a.state === "SENDING" && b?.state !== "SENDING")
      problems.push(`request ${rid} newly SENDING`);
  }
  for (const rid of Object.keys(before.requests))
    if (!after.requests[rid]) problems.push(`request ${rid} disappeared`);
  if (after.outboundMessages !== before.outboundMessages)
    problems.push("outbound message count changed");
  if (after.statusEvents !== before.statusEvents) problems.push("a delivery status event appeared");
  if (after.sessionsDigest !== before.sessionsDigest) problems.push("a bot session changed");
  return problems;
}

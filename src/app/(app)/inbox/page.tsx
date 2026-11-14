import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requestHeaders } from "@/lib/request-headers";
import { getAccessSummary, getPageAccess, pageRedirectFor } from "@/modules/access";
import {
  INBOX_VIEWS,
  getConversationDetail,
  listConversations,
  listInboxAccounts,
  listMessages,
  readInboxConfig,
  type ConversationPage,
  type InboxView,
} from "@/modules/inbox";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { InboxApp, type Initial } from "./inbox-app";

export const metadata: Metadata = { title: "Inbox · A/L ICT WhatsApp Platform" };

// The staff inbox page. Server component: it checks access, then renders the first page of data from the database so the
// screen is useful before any JavaScript runs. This is a convenience gate, not the security boundary: every API route the
// client calls authorizes again on its own. Filters and the open conversation live in the URL, so a refresh keeps them.

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok") redirect(pageRedirectFor(access.status, "/inbox"));
  const { ctx } = access;
  const params = await searchParams;

  const rawView = one(params.view);
  // The Bot attention view needs bot.read: for anyone else it is not a view at all.
  const view: InboxView =
    (INBOX_VIEWS as readonly string[]).includes(rawView ?? "") &&
    (rawView !== "botAttention" || ctx.can("bot.read"))
      ? (rawView as InboxView)
      : "all";
  const rawQ = (one(params.q) ?? "").trim().slice(0, 64);
  const q = rawQ.length >= 2 ? rawQ : "";
  const rawAccount = one(params.account);
  const accountId = rawAccount && UUID.test(rawAccount) ? rawAccount : null;
  const rawSelected = one(params.c);
  const selectedId = rawSelected && UUID.test(rawSelected) ? rawSelected : null;

  const [accounts, summary] = await Promise.all([listInboxAccounts(ctx), getAccessSummary(ctx)]);

  let list: ConversationPage;
  try {
    list = await listConversations(ctx, {
      view,
      limit: 30,
      ...(q ? { q } : {}),
      ...(accountId ? { accountId } : {}),
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    list = { items: [], nextCursor: null };
  }

  let selected: Initial["selected"] = null;
  let selectedMissing = false;
  if (selectedId) {
    try {
      const [detail, messages] = await Promise.all([
        getConversationDetail(ctx, selectedId),
        listMessages(ctx, selectedId, { limit: 40 }),
      ]);
      selected = { detail, messages };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      selectedMissing = true;
    }
  }

  const config = readInboxConfig(process.env);
  return (
    <div className="h-[calc(100dvh-3rem)] min-h-0">
      <InboxApp
        initial={{
          query: { view, q, accountId },
          list,
          accounts,
          selectedId,
          selected,
          selectedMissing,
        }}
        me={{
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          membershipId: ctx.membershipId,
          name: summary.userName,
          role: ctx.role,
          botRead: ctx.can("bot.read"),
        }}
        polling={{ listMs: config.listPollMs, chatMs: config.chatPollMs }}
      />
    </div>
  );
}

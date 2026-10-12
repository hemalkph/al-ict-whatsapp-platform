"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  AssigneeOption,
  ConversationDetail,
  ConversationStatus,
  NoteView,
  TagView,
} from "@/modules/inbox";
import { ApiError, api, isAbort } from "./api";
import { fullTime } from "./format";
import { STATUS_LABEL, STATUS_ORDER } from "./labels";

type Props = {
  detail: ConversationDetail;
  meMembershipId: string;
  /** Increments on every chat poll, so lists inside the panel (notes) refresh at the same cadence. */
  pollTick: number;
  onChanged: () => void;
  onClose: () => void;
};

const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700";
const field = `w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-500 ${focus}`;
const heading = "text-xs font-semibold uppercase tracking-wide text-zinc-600";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-zinc-200 px-4 py-4" aria-label={title}>
      <h3 className={heading}>{title}</h3>
      <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-800">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-zinc-600">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

const when = (iso: string | null) =>
  iso ? (
    <time dateTime={iso} suppressHydrationWarning>
      {fullTime(iso)}
    </time>
  ) : (
    "—"
  );

function conflictOrError(error: unknown, what: string): string {
  if (error instanceof ApiError) {
    if (error.code === "STALE_STATE")
      return `Someone else changed this ${what} just now. It has been refreshed; please check and try again.`;
    if (error.status === 403) return "You do not have permission to do that.";
    if (error.status === 404) return "This conversation is no longer available.";
    if (error.code === "VALIDATION_ERROR")
      return "That choice is not valid any more. It has been refreshed.";
  }
  return "That did not work. Please try again.";
}

export function DetailsPanel({ detail, meMembershipId, pollTick, onChanged, onClose }: Props) {
  const { can, contact } = detail;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function mutate(fn: () => Promise<unknown>, what: string) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setNotice(conflictOrError(error, what));
    } finally {
      setBusy(false);
      onChanged(); // always reload: after a success it shows the result, after a conflict it shows the winner
    }
  }

  const setStatus = (to: ConversationStatus) =>
    mutate(
      () =>
        api(`/api/inbox/conversations/${detail.id}/status`, {
          method: "POST",
          body: { to, expected: detail.status },
        }),
      "status",
    );
  const setAssignee = (membershipId: string | null) =>
    mutate(
      () =>
        api(`/api/inbox/conversations/${detail.id}/assignment`, {
          method: "POST",
          body: {
            assigneeMembershipId: membershipId,
            expectedAssigneeMembershipId: detail.assignee?.membershipId ?? null,
          },
        }),
      "assignment",
    );

  return (
    <aside
      aria-label="Contact and conversation details"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-white"
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-zinc-900">
            {contact.label.displayName}
          </h2>
          {contact.label.idHint ? (
            <p className="text-xs text-zinc-600">{contact.label.idHint}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`rounded-md px-2 py-1 text-sm text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-50 xl:hidden ${focus}`}
        >
          Close
        </button>
      </div>

      <div aria-live="polite" className="px-4">
        {notice ? (
          <p role="alert" className="mt-3 rounded-md bg-amber-50 p-2 text-sm text-amber-950">
            {notice}
          </p>
        ) : null}
      </div>

      <Section title="Conversation">
        <div>
          <p className="mb-1 text-zinc-600">Status</p>
          {can.manage ? (
            <div role="group" aria-label="Conversation status" className="flex gap-1.5">
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={detail.status === s}
                  disabled={busy}
                  onClick={() => detail.status !== s && setStatus(s)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium ring-1 ring-inset disabled:opacity-60 ${focus} ${
                    detail.status === s
                      ? "bg-emerald-700 text-white ring-emerald-700"
                      : "bg-white text-zinc-800 ring-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          ) : (
            <p className="font-medium">{STATUS_LABEL[detail.status]}</p>
          )}
          <p className="mt-1.5 text-xs text-zinc-600">
            Changing the status is internal. It does not message the customer or change the 24-hour
            reply window.
          </p>
        </div>
        <AssignmentControl
          detail={detail}
          meMembershipId={meMembershipId}
          busy={busy}
          onAssign={setAssignee}
        />
        <Row label="Our number">{detail.account.label}</Row>
        <Row label="Customer last wrote">{when(detail.lastInboundAt)}</Row>
        <Row label="Our last reply">{when(detail.lastOutboundAt)}</Row>
        <Row label="Started">{when(detail.createdAt)}</Row>
      </Section>

      <Section title="Contact">
        <Row label="First seen">{when(contact.firstSeenAt)}</Row>
        <Row label="Last seen">{when(contact.lastSeenAt)}</Row>
        <Row label="Marketing consent">
          {contact.marketingConsent === "GRANTED"
            ? "Granted"
            : contact.marketingConsent === "WITHDRAWN"
              ? "Withdrawn"
              : "Not recorded"}
        </Row>
        {contact.identity.hasCurrentBsuid ? (
          <Row label="WhatsApp user ID">{contact.identity.bsuidTail}</Row>
        ) : null}
        {contact.identity.lastObservedPhone ? (
          <Row label={contact.identity.phoneIsHistorical ? "Last seen number" : "Contact's number"}>
            {contact.identity.lastObservedPhone}
          </Row>
        ) : null}
        {contact.identity.phoneIsHistorical ? (
          <p className="rounded-md bg-zinc-100 p-2 text-xs text-zinc-700">
            This number was seen earlier for this contact and may not belong to them now, so replies
            are not sent to it. The name shown comes from the customer&apos;s WhatsApp profile and
            is not verified.
          </p>
        ) : (
          <p className="text-xs text-zinc-600">
            The name shown comes from the customer&apos;s WhatsApp profile and is not verified. A
            contact is not necessarily a registered student.
          </p>
        )}
      </Section>

      <TagsSection detail={detail} busy={busy} mutate={mutate} />
      {can.manage ? <NotesSection conversationId={detail.id} pollTick={pollTick} /> : null}

      <Section title="History">
        {detail.history.length === 0 ? (
          <p className="text-zinc-600">No status or assignment changes yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.history.map((h) => (
              <li key={h.id} className="text-xs text-zinc-700">
                <span className="font-medium">{h.actorName}</span>{" "}
                {h.kind === "STATUS"
                  ? `changed the status from ${STATUS_LABEL[h.from as ConversationStatus] ?? h.from} to ${STATUS_LABEL[h.to as ConversationStatus] ?? h.to}`
                  : h.to
                    ? `assigned it to ${h.to}${h.from ? ` (was ${h.from})` : ""}`
                    : `unassigned it${h.from ? ` (was ${h.from})` : ""}`}
                {" · "}
                {when(h.at)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}

function AssignmentControl({
  detail,
  meMembershipId,
  busy,
  onAssign,
}: {
  detail: ConversationDetail;
  meMembershipId: string;
  busy: boolean;
  onAssign: (membershipId: string | null) => void;
}) {
  const [options, setOptions] = useState<AssigneeOption[] | null>(null);
  const manage = detail.can.manage;
  useEffect(() => {
    if (!manage) return;
    const controller = new AbortController();
    api<{ assignees: AssigneeOption[] }>("/api/inbox/assignees", { signal: controller.signal })
      .then((r) => setOptions(r.assignees))
      .catch((e: unknown) => {
        if (!isAbort(e)) setOptions([]);
      });
    return () => controller.abort();
  }, [manage]);

  const current = detail.assignee;
  if (!manage)
    return (
      <Row label="Assigned to">
        {current ? `${current.name}${current.suspended ? " (inactive)" : ""}` : "Unassigned"}
      </Row>
    );
  return (
    <div>
      <label htmlFor="assignee-select" className="mb-1 block text-zinc-600">
        Assigned to
      </label>
      <select
        id="assignee-select"
        value={current?.membershipId ?? ""}
        disabled={busy || options === null}
        onChange={(e) => onAssign(e.target.value || null)}
        className={field}
      >
        <option value="">Unassigned</option>
        {current && !options?.some((o) => o.membershipId === current.membershipId) ? (
          <option value={current.membershipId} disabled>
            {current.name} (inactive)
          </option>
        ) : null}
        {options?.map((o) => (
          <option key={o.membershipId} value={o.membershipId}>
            {o.name}
            {o.membershipId === meMembershipId ? " (me)" : ""}
          </option>
        ))}
      </select>
      <div className="mt-1.5 flex gap-2">
        {current?.membershipId !== meMembershipId ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAssign(meMembershipId)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-50 disabled:opacity-60 ${focus}`}
          >
            Assign to me
          </button>
        ) : null}
        {current ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAssign(null)}
            className={`rounded-md px-2.5 py-1 text-xs text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 disabled:opacity-60 ${focus}`}
          >
            Unassign
          </button>
        ) : null}
      </div>
      {current?.suspended ? (
        <p className="mt-1.5 text-xs text-amber-900">
          This person&apos;s account is inactive. The conversation stays assigned to them until you
          change it.
        </p>
      ) : null}
    </div>
  );
}

function TagsSection({
  detail,
  busy,
  mutate,
}: {
  detail: ConversationDetail;
  busy: boolean;
  mutate: (fn: () => Promise<unknown>, what: string) => Promise<void>;
}) {
  const { can, contact } = detail;
  const [available, setAvailable] = useState<TagView[]>([]);
  const [newName, setNewName] = useState("");

  const loadAvailable = useCallback(
    (signal?: AbortSignal) =>
      api<{ tags: TagView[] }>("/api/inbox/tags", { signal })
        .then((r) => setAvailable(r.tags))
        .catch((e: unknown) => {
          if (!isAbort(e)) setAvailable([]);
        }),
    [],
  );
  useEffect(() => {
    if (!can.editContact) return;
    const controller = new AbortController();
    void loadAvailable(controller.signal);
    return () => controller.abort();
  }, [can.editContact, loadAvailable, contact.tags.length]);

  const attached = new Set(contact.tags.map((t) => t.id));
  const addable = available.filter((t) => !attached.has(t.id));

  const add = (tagId: string) =>
    mutate(
      () => api(`/api/inbox/contacts/${contact.id}/tags`, { method: "POST", body: { tagId } }),
      "tag",
    );
  const remove = (tagId: string) =>
    mutate(
      () => api(`/api/inbox/contacts/${contact.id}/tags/${tagId}`, { method: "DELETE" }),
      "tag",
    );
  async function create(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await mutate(async () => {
      const made = await api<{ tag: TagView }>("/api/inbox/tags", {
        method: "POST",
        body: { name },
      });
      await api(`/api/inbox/contacts/${contact.id}/tags`, {
        method: "POST",
        body: { tagId: made.tag.id },
      });
      setNewName("");
    }, "tag");
  }

  return (
    <Section title="Tags">
      {contact.tags.length === 0 ? <p className="text-zinc-600">No tags.</p> : null}
      <ul className="flex flex-wrap gap-1.5" aria-label="Contact tags">
        {contact.tags.map((t) => (
          <li
            key={t.id}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 text-xs text-zinc-800 ring-1 ring-zinc-200"
          >
            {t.name}
            {t.archived ? <span className="text-zinc-600">(archived)</span> : null}
            {can.editContact ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(t.id)}
                aria-label={`Remove tag ${t.name}`}
                className={`rounded-full px-1.5 text-zinc-700 hover:bg-zinc-200 disabled:opacity-60 ${focus}`}
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {can.editContact ? (
        <>
          {addable.length > 0 ? (
            <>
              <label htmlFor="tag-add" className="sr-only">
                Add a tag
              </label>
              <select
                id="tag-add"
                value=""
                disabled={busy}
                onChange={(e) => e.target.value && add(e.target.value)}
                className={field}
              >
                <option value="">Add a tag…</option>
                {addable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {can.manageTags ? (
            <form onSubmit={create} className="flex gap-2">
              <label htmlFor="tag-new" className="sr-only">
                New tag name
              </label>
              <input
                id="tag-new"
                value={newName}
                maxLength={40}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New tag"
                className={field}
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 disabled:opacity-60 ${focus}`}
              >
                Create
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function NotesSection({ conversationId, pollTick }: { conversationId: string; pollTick: number }) {
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ notes: NoteView[] }>(`/api/inbox/conversations/${conversationId}/notes?limit=20`, {
      signal: controller.signal,
    })
      .then((r) => setNotes(r.notes))
      .catch((e: unknown) => {
        if (!isAbort(e)) setError("Notes could not be loaded.");
      });
    return () => controller.abort();
  }, [conversationId, pollTick, version]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/inbox/conversations/${conversationId}/notes`, {
        method: "POST",
        body: { body },
      });
      setText("");
      setVersion((v) => v + 1);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "VALIDATION_ERROR"
          ? "That note cannot be saved (up to 4000 characters)."
          : "The note was not saved. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Internal notes">
      <p className="text-xs text-zinc-600">
        Only staff see notes. They are never sent to the customer.
      </p>
      <form onSubmit={add} className="flex flex-col gap-2">
        <label htmlFor="note-text" className="sr-only">
          Add an internal note
        </label>
        <textarea
          id="note-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          rows={3}
          placeholder="Add an internal note"
          className={`${field} resize-y`}
        />
        <button
          type="submit"
          disabled={saving || !text.trim()}
          className={`self-end rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-700 ${focus}`}
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-red-800">
          {error}
        </p>
      ) : null}
      {notes === null && !error ? <p className="text-zinc-600">Loading notes…</p> : null}
      {notes?.length === 0 ? <p className="text-zinc-600">No notes yet.</p> : null}
      <ul className="flex flex-col gap-2" aria-label="Internal notes">
        {notes?.map((n) => (
          <li key={n.id} className="rounded-md bg-amber-50 p-2 text-sm ring-1 ring-amber-100">
            <p className="break-words whitespace-pre-wrap text-zinc-900">{n.body}</p>
            <p className="mt-1 text-xs text-zinc-600">
              {n.authorName} · {when(n.createdAt)}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

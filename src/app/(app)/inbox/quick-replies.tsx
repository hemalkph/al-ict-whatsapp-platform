"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { QuickReplyView } from "@/modules/inbox";
import { ApiError, api, isAbort } from "./api";

type Props = {
  canManage: boolean;
  onInsert: (text: string) => void;
  onClose: () => void;
};

const field =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700";

function problem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "DUPLICATE") return "A quick reply with that title already exists.";
    if (error.status === 403) return "You do not have permission to change quick replies.";
    if (error.code === "VALIDATION_ERROR")
      return "Check the title (up to 60 characters) and the text (up to 1000).";
  }
  return "That did not work. Please try again.";
}

/**
 * Reusable staff-written text. Choosing one only puts its text into the message box: it never sends anything, and it is not a
 * WhatsApp template, so it does not make a message eligible. The platform still decides whether the typed reply may be queued.
 */
export function QuickReplyPicker({ canManage, onInsert, onClose }: Props) {
  const [items, setItems] = useState<QuickReplyView[] | null>(null);
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = term.trim() ? `?q=${encodeURIComponent(term.trim().slice(0, 64))}` : "";
    api<{ quickReplies: QuickReplyView[] }>(`/api/inbox/quick-replies${query}`, {
      signal: controller.signal,
    })
      .then((r) => {
        setItems(r.quickReplies);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!isAbort(e)) setError("Quick replies could not be loaded.");
      });
    return () => controller.abort();
  }, [term, version]);

  const save = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!editing || busy) return;
      setBusy(true);
      setError(null);
      try {
        const body = { title: editing.title.trim(), body: editing.body };
        if (editing.id)
          await api(`/api/inbox/quick-replies/${editing.id}`, { method: "PATCH", body });
        else await api("/api/inbox/quick-replies", { method: "POST", body });
        setEditing(null);
        setVersion((v) => v + 1);
      } catch (err) {
        setError(problem(err));
      } finally {
        setBusy(false);
      }
    },
    [editing, busy],
  );

  const archive = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/inbox/quick-replies/${id}`, { method: "PATCH", body: { archived: true } });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Quick replies"
      className="absolute bottom-full left-3 z-30 mb-2 w-[min(26rem,calc(100vw-1.5rem))] rounded-lg border border-zinc-200 bg-white p-3 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">Quick replies</h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-sm text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
          aria-label="Close quick replies"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        Choosing one only fills the message box. It is not sent, and it does not allow a message
        outside the 24-hour reply window.
      </p>
      <label className="sr-only" htmlFor="quick-reply-search">
        Search quick replies
      </label>
      <input
        id="quick-reply-search"
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search quick replies"
        maxLength={64}
        className={`${field} mt-2`}
        autoFocus
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-800">
          {error}
        </p>
      ) : null}

      {editing ? (
        <form onSubmit={save} className="mt-3 flex flex-col gap-2">
          <label className="text-xs font-medium text-zinc-800">
            Title
            <input
              className={`${field} mt-1`}
              value={editing.title}
              maxLength={60}
              required
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
          </label>
          <label className="text-xs font-medium text-zinc-800">
            Text
            <textarea
              className={`${field} mt-1 min-h-24`}
              value={editing.body}
              maxLength={1000}
              required
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save quick reply"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <ul className="mt-2 max-h-56 overflow-y-auto" aria-label="Quick reply list">
            {items === null ? <li className="p-2 text-xs text-zinc-600">Loading…</li> : null}
            {items?.length === 0 ? (
              <li className="p-2 text-xs text-zinc-600">
                {term ? "No quick reply matches." : "No quick replies yet."}
              </li>
            ) : null}
            {items?.map((q) => (
              <li
                key={q.id}
                className="flex items-start gap-1 border-b border-zinc-100 last:border-0"
              >
                <button
                  type="button"
                  onClick={() => onInsert(q.body)}
                  className="min-w-0 flex-1 rounded px-2 py-2 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700"
                >
                  <span className="block truncate text-sm font-medium text-zinc-900">
                    {q.title}
                  </span>
                  <span className="line-clamp-2 text-xs text-zinc-600">{q.body}</span>
                </button>
                {canManage ? (
                  <span className="flex shrink-0 flex-col gap-1 py-1.5">
                    <button
                      type="button"
                      onClick={() => setEditing({ id: q.id, title: q.title, body: q.body })}
                      className="rounded px-1.5 text-xs text-zinc-700 underline hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
                      aria-label={`Edit ${q.title}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => archive(q.id)}
                      className="rounded px-1.5 text-xs text-zinc-700 underline hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
                      aria-label={`Archive ${q.title}`}
                    >
                      Archive
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <button
              type="button"
              onClick={() => setEditing({ id: null, title: "", body: "" })}
              className="mt-2 rounded-md px-3 py-1.5 text-sm font-medium text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
            >
              New quick reply
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

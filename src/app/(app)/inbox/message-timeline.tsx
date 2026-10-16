"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeliveryView, TimelineMessage } from "@/modules/inbox";
import { clockTime, dayKey, dayLabel, fileSize, fullTime } from "./format";

type Props = {
  messages: TimelineMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  /** First message the viewer had not seen when the conversation opened: a "New messages" divider goes above it. */
  newFromId: string | null;
  onLoadOlder: () => void;
  onReply: (message: TimelineMessage) => void;
  canReply: boolean;
  /** The timeline can actually be seen (not covered by the Details pane, not a hidden pane). */
  active: boolean;
  /** Called with the ids of unseen inbound messages that are on screen right now (stable function; the caller de-duplicates). */
  onSeen: (ids: string[]) => void;
};

const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};

const severityStyle = {
  neutral: "text-zinc-600",
  good: "text-emerald-800",
  warning: "text-amber-900",
  error: "text-red-800",
} as const;

// Phases whose explanation is worth showing under the message. For SENT / DELIVERED / READ the label says it all.
const SHOW_DETAIL = new Set(["QUEUED", "SENDING", "ACCEPTED", "HELD", "REJECTED", "FAILED"]);

function Delivery({ delivery }: { delivery: DeliveryView }) {
  if (delivery.phase === "NONE") return null;
  const warn = delivery.phase === "UNKNOWN_OUTCOME";
  return warn ? (
    <div
      role="alert"
      className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950"
    >
      <p className="font-semibold">⚠ {delivery.label}</p>
      <p className="mt-0.5">{delivery.detail}</p>
    </div>
  ) : (
    <p
      className={`mt-1 text-right text-xs ${severityStyle[delivery.severity]}`}
      title={delivery.detail ?? undefined}
    >
      <span className="font-medium">{delivery.label}</span>
      {/* The explanation is shown once, as visible text, where it matters: states that are not final or not successful. */}
      {delivery.detail && SHOW_DETAIL.has(delivery.phase) ? (
        <span className="block font-normal">{delivery.detail}</span>
      ) : null}
    </p>
  );
}

export function MessageTimeline(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(new Set());
  const tabVisible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => false,
  );

  // Which unseen inbound messages are actually on screen? A message counts when at least half of it (or, for a message taller
  // than the viewport, half of the viewport) is inside the scroll area. Elements in a hidden pane are never intersecting.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) =>
        setOnScreen((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.unseenId;
            if (!id) continue;
            const mostly =
              e.isIntersecting &&
              (e.intersectionRatio >= 0.5 ||
                (e.rootBounds !== null && e.intersectionRect.height >= e.rootBounds.height * 0.5));
            if (mostly) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    root.querySelectorAll("[data-unseen-id]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [p.messages]);

  // Report them only while the pane is really visible and the tab is in the foreground.
  const { messages, active, onSeen } = p;
  useEffect(() => {
    if (!active || !tabVisible) return;
    const ids = messages.filter((m) => m.unseen && onScreen.has(m.id)).map((m) => m.id);
    if (ids.length > 0) onSeen(ids);
  }, [messages, onScreen, active, tabVisible, onSeen]);

  // Keep the newest message in view when the reader is at the bottom; never yank them while they read older messages.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current || lastCount.current === 0) el.scrollTop = el.scrollHeight;
    lastCount.current = p.messages.length;
  }, [p.messages]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Messages"
      aria-live="polite"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="chat-wallpaper min-h-0 flex-1 overflow-y-auto px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700 sm:px-6"
    >
      {p.hasOlder ? (
        <div className="mb-4 text-center">
          <button
            type="button"
            onClick={() => {
              stick.current = false;
              p.onLoadOlder();
            }}
            disabled={p.loadingOlder}
            className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
          >
            {p.loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        </div>
      ) : null}

      {p.messages.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-600">
          No messages in this conversation yet.
        </p>
      ) : null}

      <ol className="flex flex-col gap-1.5">
        {p.messages.map((m, index) => {
          const showDay =
            index === 0 || dayKey(p.messages[index - 1]!.occurredAt) !== dayKey(m.occurredAt);
          const out = m.direction === "OUTBOUND";
          const canQuote =
            p.canReply &&
            m.type !== "REACTION" &&
            m.type !== "SYSTEM" &&
            (!out || ["ACCEPTED", "SENT", "DELIVERED", "READ"].includes(m.delivery?.phase ?? ""));
          return (
            <li
              key={m.id}
              className="flex flex-col"
              data-unseen-id={m.unseen && !out ? m.id : undefined}
            >
              {showDay ? (
                <div className="my-2 text-center text-xs font-medium text-zinc-600">
                  <span
                    suppressHydrationWarning
                    className="inline-block rounded-md bg-white/95 px-2.5 py-1 shadow-sm"
                  >
                    {dayLabel(m.occurredAt)}
                  </span>
                </div>
              ) : null}
              {m.id === p.newFromId ? (
                <div className="my-2 flex items-center gap-2 text-xs font-semibold text-emerald-800">
                  <span className="h-px flex-1 bg-emerald-300" />
                  <span className="rounded-md bg-white/95 px-2.5 py-1 shadow-sm">New messages</span>
                  <span className="h-px flex-1 bg-emerald-300" />
                </div>
              ) : null}
              <div className={`group flex ${out ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[65%] ${
                    out
                      ? "rounded-tr-sm bg-[#d9fdd3] text-zinc-900"
                      : "rounded-tl-sm bg-white text-zinc-900"
                  }`}
                >
                  <p className="sr-only">{out ? "Sent by us" : "From the customer"}</p>
                  {m.reply ? (
                    <div className="mb-1.5 rounded-md border-l-4 border-emerald-600 bg-black/5 px-2 py-1 text-xs text-zinc-700">
                      {m.reply.resolved ? (
                        <>
                          <span className="font-semibold">
                            {m.reply.direction === "OUTBOUND" ? "You" : "Customer"}
                          </span>
                          <span className="block truncate">{m.reply.preview ?? "Message"}</span>
                        </>
                      ) : (
                        <span>Replied to an earlier message</span>
                      )}
                    </div>
                  ) : null}
                  {m.placeholder && m.type !== "TEXT" && m.type !== "REACTION" ? (
                    <p className="mb-0.5 text-xs font-medium text-zinc-600">{m.placeholder}</p>
                  ) : null}
                  {m.media.map((a, i) => (
                    <p key={i} className="mb-0.5 text-xs text-zinc-600">
                      {[a.filename, a.mimeType, fileSize(a.sizeBytes)]
                        .filter(Boolean)
                        .join(" · ") || "Attachment"}
                      {" · "}
                      {a.state === "PENDING"
                        ? "not downloaded"
                        : a.state === "EXPIRED"
                          ? "no longer available"
                          : a.state === "FAILED"
                            ? "could not be downloaded"
                            : "stored"}
                    </p>
                  ))}
                  {m.text ? (
                    <p className="break-words whitespace-pre-wrap">{m.text}</p>
                  ) : m.type === "TEXT" ? (
                    <p className="text-zinc-600 italic">{m.placeholder}</p>
                  ) : null}
                  {m.type === "REACTION" ? <p>Reacted {m.text}</p> : null}
                  <div className="mt-1 flex items-center justify-end gap-2 text-xs text-zinc-600">
                    {canQuote ? (
                      <button
                        type="button"
                        onClick={() => p.onReply(m)}
                        className="rounded px-1 text-zinc-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700"
                      >
                        Reply
                      </button>
                    ) : null}
                    <time
                      dateTime={m.occurredAt}
                      title={fullTime(m.occurredAt)}
                      suppressHydrationWarning
                    >
                      {clockTime(m.occurredAt)}
                    </time>
                  </div>
                  {m.delivery ? <Delivery delivery={m.delivery} /> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A small modal confirmation built on the native <dialog>: focus is trapped inside while it is open, Escape and the "keep" button
 * both mean "do nothing", and the SAFE choice is focused first. Mount it only while it should be shown.
 */
export function ConfirmDialog({
  title,
  children,
  keepLabel,
  confirmLabel,
  onKeep,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  keepLabel: string;
  confirmLabel: string;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault(); // Escape means "keep"
        onKeep();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-zinc-300 bg-white p-4 text-sm text-zinc-900 shadow-xl backdrop:bg-black/40"
    >
      <h2 id="confirm-title" className="text-base font-semibold">
        {title}
      </h2>
      <div className="mt-2 space-y-2">{children}</div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          autoFocus
          onClick={onKeep}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          {keepLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md px-3 py-1.5 text-sm text-red-800 ring-1 ring-red-400 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-700"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function ChangePasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== form.get("confirmPassword")) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword }),
      });
      if (response.ok) {
        router.replace("/"); // the server re-checks access and lets the user in
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; fields?: string[] };
      } | null;
      const code = body?.error?.code;
      if (code === "VALIDATION_ERROR" && body?.error?.fields?.includes("currentPassword"))
        setError("The current password is incorrect.");
      else if (code === "VALIDATION_ERROR")
        setError("The new password must be 12 to 128 characters.");
      else if (code === "PASSWORD_CHANGE_INCOMPLETE")
        setError(body?.error?.message ?? "Please try again.");
      else if (response.status === 401) router.replace("/login");
      else setError("The password could not be changed. Please try again.");
    } catch {
      setError("The password could not be changed. Please try again.");
    }
    setBusy(false);
  }

  const field = "rounded border border-zinc-300 px-3 py-2";
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Current password
        <input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        New password (12 to 128 characters)
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Confirm new password
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          className={field}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        Change password
      </button>
    </form>
  );
}

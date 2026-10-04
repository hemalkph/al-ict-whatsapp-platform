"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      // Better Auth's supported sign-out: invalidates the database session and clears the cookie.
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="rounded border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50"
    >
      Sign out
    </button>
  );
}

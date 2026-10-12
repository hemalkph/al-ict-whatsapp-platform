import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getPageAccess, pageRedirectFor } from "@/modules/access";
import { SignOutButton } from "./sign-out-button";

// Convenience/UX gate for everything in this group. It is NOT the security boundary: every page and every
// data/service function still calls requireAccess/requirePermission itself (layouts do not re-run on every
// navigation).
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok") redirect(pageRedirectFor(access.status));
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 px-4 sm:px-6">
        <nav aria-label="Main" className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm font-medium focus-visible:outline-2 focus-visible:outline-emerald-700"
          >
            A/L ICT WhatsApp Platform
          </Link>
          <Link
            href="/inbox"
            className="rounded px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
          >
            Inbox
          </Link>
        </nav>
        <SignOutButton />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}

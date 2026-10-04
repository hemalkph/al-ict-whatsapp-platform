import type { ReactNode } from "react";
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
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3">
        <span className="text-sm font-medium">A/L ICT WhatsApp Platform</span>
        <SignOutButton />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}

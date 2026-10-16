"use client";

import { usePathname } from "next/navigation";

/** The section name in the top bar (the page's own heading stays inside the page). */
export function PageTitle() {
  const pathname = usePathname();
  const title = pathname.startsWith("/inbox")
    ? "Inbox"
    : pathname.startsWith("/leads")
      ? "Leads"
      : "Home";
  return <span className="truncate text-sm font-medium text-zinc-700">{title}</span>;
}

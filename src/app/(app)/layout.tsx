import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestHeaders } from "@/lib/request-headers";
import { getAccessSummary, getPageAccess, pageRedirectFor } from "@/modules/access";
import { AppSidebar } from "./app-sidebar";
import { PageTitle } from "./page-title";

// Convenience/UX gate for everything in this group. It is NOT the security boundary: every page and every
// data/service function still calls requireAccess/requirePermission itself (layouts do not re-run on every
// navigation).
//
// The shell: a sidebar (collapses to icons; a sheet on phones) and a slim top bar with the sidebar toggle and the page's name.
// The sidebar remembers open/closed in its own cookie (a display preference, nothing else); reading it here lets the server
// render the same state the browser will show.
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok") redirect(pageRedirectFor(access.status));
  const summary = await getAccessSummary(access.ctx);
  const open = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={open} className="min-h-dvh">
        <AppSidebar
          userName={summary.userName}
          role={summary.role}
          organizationName={summary.organizationName}
          canReadLeads={access.ctx.can("lead.read")}
        />
        <SidebarInset className="min-w-0">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-vertical:h-4" />
            <PageTitle />
          </header>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

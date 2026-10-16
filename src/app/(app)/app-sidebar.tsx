"use client";

import { InboxIcon, LogOutIcon, MessageCircleIcon, TargetIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { SignOutButton } from "./sign-out-button";

// The application sidebar (after the shadcn sidebar-07 layout: collapses to icons on desktop, a sheet on phones). It lists only
// pages that exist and that the role may open; every page still authorizes on its own, so the list is guidance, not security.
// Everything shown comes from the server-validated session (name, role, organization).

type Item = { href: string; label: string; icon: React.ReactNode };

const ROLE_LABEL: Record<string, string> = { ADMIN: "Admin", STAFF: "Staff", VIEWER: "Viewer" };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]!.toUpperCase())
    .join("") || "?";

export function AppSidebar({
  userName,
  role,
  organizationName,
  canReadLeads,
}: {
  userName: string;
  role: string;
  organizationName: string;
  canReadLeads: boolean;
}) {
  const pathname = usePathname();
  // On a phone the sidebar is a sheet over the page: choosing a destination must close it (the sidebar's own state, not the DOM).
  // A no-op on desktop, where the sidebar is not a sheet. Done in the click, so choosing the page you are already on closes it too.
  const { setOpenMobile } = useSidebar();
  const closeSheet = () => setOpenMobile(false);
  const items: Item[] = [
    { href: "/inbox", label: "Inbox", icon: <InboxIcon /> },
    ...(canReadLeads ? [{ href: "/leads", label: "Leads", icon: <TargetIcon /> }] : []),
  ];
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Home"
              render={<Link href="/" />}
              onClick={closeSheet}
            >
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <MessageCircleIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">A/L ICT WhatsApp</span>
                <span className="text-sidebar-foreground/70 truncate text-xs">
                  {organizationName}
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <nav aria-label="Main">
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    tooltip={item.label}
                    isActive={isCurrent(item.href)}
                    aria-current={isCurrent(item.href) ? "page" : undefined}
                    render={<Link href={item.href} />}
                    onClick={closeSheet}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 rounded-md p-2 group-data-[collapsible=icon]:p-0">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold text-emerald-900"
              >
                {initials(userName)}
              </span>
              <span className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium">{userName}</span>
                <span className="text-sidebar-foreground/70 truncate text-xs">
                  {ROLE_LABEL[role] ?? role}
                </span>
              </span>
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SignOutButton className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden group-data-[collapsible=icon]:size-8 focus-visible:ring-2 disabled:opacity-50">
              <LogOutIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">Sign out</span>
            </SignOutButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

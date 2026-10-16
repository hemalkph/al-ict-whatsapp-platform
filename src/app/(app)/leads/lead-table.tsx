"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LeadItem } from "@/modules/leads";
import { fullTime } from "../inbox/format";
import { leadPath } from "./[id]/lead-detail";
import type { LeadFilters } from "./lead-filters";
import { isOpenStatus, sourceLabel, statusLabel } from "./lead-labels";

// The leads table. Read-only: the contact name links to the lead page (07D-3, a real link, so it works with the keyboard, a new tab
// and a screen reader), carrying the list's filters so the page can offer "Back to leads". Nothing here changes a lead.
// Every text comes from the server's view (already cleaned) or from lead-labels.ts; React escapes all of it.

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-zinc-500">—</span>;
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {fullTime(iso)}
    </time>
  );
}

function StatusBadge({ lead }: { lead: LeadItem }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={isOpenStatus(lead.status) ? "secondary" : "outline"}>
        {statusLabel(lead.status)}
      </Badge>
      {lead.readOnly ? (
        <span className="inline-flex items-center gap-1 text-xs text-zinc-600">
          <LockIcon aria-hidden="true" className="size-3" />
          Read-only
        </span>
      ) : null}
    </span>
  );
}

export function LeadTable({
  items,
  busy,
  filters,
}: {
  items: readonly LeadItem[];
  busy: boolean;
  filters: LeadFilters;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200" aria-busy={busy}>
      <Table>
        <caption className="sr-only">Leads, newest first</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Contact</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Source</TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Created
            </TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Status changed
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((lead) => (
            <TableRow key={lead.id}>
              <TableCell className="max-w-64 whitespace-normal">
                <div className="font-medium text-zinc-900">
                  <Link
                    href={leadPath(lead.id, filters)}
                    className="rounded-sm break-words text-emerald-900 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:outline-none"
                  >
                    {lead.contact.label.displayName}
                  </Link>
                </div>
                <div className="flex flex-wrap gap-x-2 text-xs text-zinc-600">
                  {lead.contact.label.idHint ? <span>{lead.contact.label.idHint}</span> : null}
                  {lead.contact.archived ? <span>Archived contact</span> : null}
                  <span className="md:hidden">
                    Created <When iso={lead.createdAt} />
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge lead={lead} />
              </TableCell>
              <TableCell className="max-w-56 whitespace-normal text-zinc-800">
                {sourceLabel(lead.source)}
              </TableCell>
              <TableCell className="hidden text-zinc-700 md:table-cell">
                <When iso={lead.createdAt} />
              </TableCell>
              <TableCell className="hidden text-zinc-700 md:table-cell">
                <When iso={lead.statusChangedAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function LeadTableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

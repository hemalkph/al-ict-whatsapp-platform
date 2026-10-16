"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { LeadStatus } from "@/modules/leads";
import {
  ATTRIBUTION_FILTER_LABEL,
  SEARCH_MAX,
  SEARCH_MIN,
  STATE_FILTER_LABEL,
  checkSearch,
  type AttributionFilter,
  type LeadFilters,
  type StateFilter,
} from "./lead-filters";
import { LEAD_STATUSES, STATUS_LABEL, isReservedStatus } from "./lead-labels";

// The search box and the three filters. Every choice goes through the page's URL (onChange); the controls only reflect the
// filters the URL holds. A status decides open/closed by itself (lead-filters.ts), so choosing a status shows "All" in the state
// control, and choosing Open or Closed clears the status: never two active filters where one was silently discarded.

const ANY = "any";
const STATUS_ITEMS: Record<string, string> = {
  [ANY]: "Any status",
  ...Object.fromEntries(
    LEAD_STATUSES.map((s) => [
      s,
      isReservedStatus(s) ? `${STATUS_LABEL[s]} (read-only)` : STATUS_LABEL[s],
    ]),
  ),
};
const ATTRIBUTION_ITEMS: Record<AttributionFilter, string> = ATTRIBUTION_FILTER_LABEL;

export function LeadFilterToolbar({
  filters,
  draft,
  disabled,
  onDraftChange,
  onChange,
}: {
  filters: LeadFilters;
  draft: string;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onChange: (next: LeadFilters) => void;
}) {
  const check = checkSearch(draft);
  const hint =
    check.kind === "too_short"
      ? `Type at least ${SEARCH_MIN} characters to search. No search is applied yet.`
      : check.kind === "ok" && check.truncated
        ? `Only the first ${SEARCH_MAX} characters are searched.`
        : filters.q
          ? `Searching names, usernames and numbers for “${filters.q}”.`
          : "Search by name, username or the start of a number.";

  return (
    <div
      role="search"
      aria-label="Filter leads"
      className="flex flex-col gap-3 lg:flex-row lg:items-end"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="lead-search">Search</Label>
        <Input
          id="lead-search"
          type="search"
          value={draft}
          disabled={disabled}
          maxLength={200}
          autoComplete="off"
          placeholder="Name, username or number"
          aria-describedby="lead-search-hint"
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <p id="lead-search-hint" className="text-xs text-zinc-600">
          {hint}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span id="lead-state-label" className="text-sm font-medium">
          State
        </span>
        <ToggleGroup
          aria-labelledby="lead-state-label"
          variant="outline"
          disabled={disabled}
          value={[filters.state]}
          onValueChange={(value) => {
            const next = value[0] as StateFilter | undefined;
            if (!next || next === filters.state) return;
            onChange({ ...filters, state: next, status: null });
          }}
        >
          {(Object.keys(STATE_FILTER_LABEL) as StateFilter[]).map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {STATE_FILTER_LABEL[s]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="h-4 text-xs text-zinc-600">
          {filters.status ? "Set by the status filter" : ""}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id="lead-status-label">Status</Label>
        <Select
          items={STATUS_ITEMS}
          value={filters.status ?? ANY}
          disabled={disabled}
          onValueChange={(value) => {
            const status = value === ANY || value === null ? null : (value as LeadStatus);
            if (status === filters.status) return;
            onChange({ ...filters, status, state: "all" });
          }}
        >
          <SelectTrigger aria-labelledby="lead-status-label" className="w-full lg:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="h-4 text-xs text-zinc-600" aria-hidden="true" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id="lead-attribution-label">Ad referral</Label>
        <Select
          items={ATTRIBUTION_ITEMS}
          value={filters.attribution}
          disabled={disabled}
          onValueChange={(value) => {
            const attribution = (value ?? "any") as AttributionFilter;
            if (attribution !== filters.attribution) onChange({ ...filters, attribution });
          }}
        >
          <SelectTrigger aria-labelledby="lead-attribution-label" className="w-full lg:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ATTRIBUTION_ITEMS) as AttributionFilter[]).map((value) => (
              <SelectItem key={value} value={value}>
                {ATTRIBUTION_ITEMS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="h-4 text-xs text-zinc-600">
          {filters.attribution === "none" ? "Other referrals may still be recorded" : ""}
        </p>
      </div>
    </div>
  );
}

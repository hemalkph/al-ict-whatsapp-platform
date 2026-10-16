import { Skeleton } from "@/components/ui/skeleton";

// Shown while the server renders a lead (navigation from the list). Same outline as the page, so nothing jumps.
export default function LeadDetailLoading() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6" aria-busy="true">
      <p role="status" className="sr-only">
        Loading lead…
      </p>
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-7 w-64 max-w-full" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </main>
  );
}

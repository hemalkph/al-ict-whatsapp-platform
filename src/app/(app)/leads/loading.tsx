import { Skeleton } from "@/components/ui/skeleton";

// Shown while the server renders the Leads page (navigation from another page). Same outline as the page, so nothing jumps.
export default function LeadsLoading() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6" aria-busy="true">
      <p role="status" className="sr-only">
        Loading leads…
      </p>
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-16 w-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </main>
  );
}

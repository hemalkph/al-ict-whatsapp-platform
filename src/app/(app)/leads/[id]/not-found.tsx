import Link from "next/link";

// One page for every lead the viewer cannot open: it does not exist, the id is malformed, or it belongs to another organization.
// The words are the same for all three, so this page says nothing about whether the lead exists elsewhere.
export default function LeadNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 sm:p-6">
      <h1 className="text-xl font-semibold text-zinc-900">Lead not available</h1>
      <p role="alert" className="text-sm text-zinc-700">
        This lead or contact is not available.
      </p>
      <Link
        href="/leads"
        className="w-fit rounded-sm text-sm font-medium text-emerald-800 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:outline-none"
      >
        Back to leads
      </Link>
    </main>
  );
}

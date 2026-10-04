import { redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getAccessSummary, getPageAccess, pageRedirectFor } from "@/modules/access";

// Minimal authenticated landing page. Everything shown is derived on the server from the validated session and the
// ACTIVE membership (AccessContext); nothing comes from browser state.
export default async function HomePage() {
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok") redirect(pageRedirectFor(access.status));
  const summary = await getAccessSummary(access.ctx);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold">Signed in</h1>
      <dl className="text-sm text-zinc-600">
        <div>
          <dt className="inline font-medium">Name: </dt>
          <dd className="inline">{summary.userName}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Organization: </dt>
          <dd className="inline">{summary.organizationName}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Role: </dt>
          <dd className="inline">{summary.role}</dd>
        </div>
      </dl>
    </main>
  );
}

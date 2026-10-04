import { redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getPageAccess, loginDestination } from "@/modules/access";
import { safeRedirectPath } from "@/shared/security/redirect";
import { LoginForm } from "./login-form";

const NOTICES: Record<string, string> = {
  access: "Your account does not currently have access. Contact an administrator.",
  organization: "Your account needs an organization to be selected, which is not available yet.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;

  // Only a visitor who ALREADY has working access (or a pending password change) is sent onward, decided on the
  // server from the real session. Everyone else (no/stale/forged cookie, suspended, ...) sees the form: no loops.
  const destination = loginDestination(await getPageAccess(await requestHeaders()), next);
  if (destination) redirect(destination);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <LoginForm
        next={safeRedirectPath(next, "/")}
        notice={reason ? (NOTICES[reason] ?? null) : null}
      />
    </main>
  );
}

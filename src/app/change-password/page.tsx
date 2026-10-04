import { redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getPasswordChangeStatus } from "@/modules/access";
import { ChangePasswordForm } from "./change-password-form";

// Needs only a valid session (not the normal access gate): this is the one place a user with
// password_change_required = true may go. Users with nothing pending are sent to the app.
export default async function ChangePasswordPage() {
  const status = await getPasswordChangeStatus(await requestHeaders());
  if (status === "unauthenticated") redirect("/login");
  if (status === "not_required") redirect("/");
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="text-sm text-zinc-600">You must change your password before continuing.</p>
      <ChangePasswordForm />
    </main>
  );
}

import { UserRoundIcon } from "lucide-react";

// A round avatar with the contact's initials (decoration only: hidden from assistive technology, the name is always shown next to
// it). The name is the customer's WhatsApp profile name, so it is never treated as identity. Unnamed contacts get a neutral icon.

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]!.toUpperCase())
    .join("");

export function ContactAvatar({
  name,
  named,
  size = "md",
}: {
  name: string;
  named: boolean;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "size-16 text-xl" : "size-10 text-sm";
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${box} ${
        named ? "bg-emerald-100 text-emerald-900" : "bg-zinc-200 text-zinc-600"
      }`}
    >
      {named && initials(name) ? (
        initials(name)
      ) : (
        <UserRoundIcon className={size === "lg" ? "size-8" : "size-5"} />
      )}
    </span>
  );
}

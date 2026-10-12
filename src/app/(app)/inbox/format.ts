// Time and size formatting for display. Values are formatted in the viewer's own locale and time zone, so the server-rendered
// text can differ from the browser's: the elements that show them use suppressHydrationWarning for exactly that reason.

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Clock time of a message inside a conversation (the day is shown by the day separator). */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : timeOnly.format(d);
}

/** Compact time for the list: today → clock time, this year → "12 Mar", else with the year. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, now)) return timeOnly.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonth.format(d);
  return `${dayMonth.format(d)} ${d.getFullYear()}`;
}

export function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : full.format(d);
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.getFullYear() === now.getFullYear()
    ? dayMonth.format(d)
    : `${dayMonth.format(d)} ${d.getFullYear()}`;
}

export function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

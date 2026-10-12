import { z } from "zod";

// Staff-typed text (notes, quick replies, tag names, search): exact, never silently cleaned. Same rule as outbound text:
// no NUL or control characters other than newline / carriage return / tab, no malformed Unicode.

export function isPlainText(value: string): boolean {
  return value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export const plainText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(isPlainText, "invalid characters")
    .refine((v) => v.trim().length > 0, "blank");

/** Single line (titles, tag names): no line breaks either. */
export const plainLine = (min: number, max: number) =>
  plainText(min, max).refine((v) => !/[\r\n\t]/.test(v), "single line");

export const uuid = z.uuid();

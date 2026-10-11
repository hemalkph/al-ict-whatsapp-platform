import { z } from "zod";
import { TEMPLATE_PARAMETER_COUNT_MAX, TEMPLATE_PARAMETER_MAX, TEXT_BODY_MAX } from "./policy";

// Strict request schema for a staff outbound request. The browser supplies the conversation and the content; the
// organization, account, contact and recipient are NEVER inputs: they are derived from the database. Unknown keys are rejected.

/** Exact text: no NUL, no control characters other than newline / carriage return / tab, no malformed Unicode. Never cleaned. */
export function isSendableText(value: string): boolean {
  return value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(isSendableText, "invalid characters")
    .refine((v) => v.trim().length > 0, "blank");

const uuid = z.uuid();

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const submitSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  conversationId: uuid,
  message: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("text"),
      body: text(TEXT_BODY_MAX),
      replyToMessageId: uuid.optional(),
    }),
    z.strictObject({
      type: z.literal("template"),
      templateId: uuid,
      parameters: z
        .array(text(TEMPLATE_PARAMETER_MAX))
        .max(TEMPLATE_PARAMETER_COUNT_MAX)
        .default([]),
    }),
  ]),
});
export type SubmitInput = z.infer<typeof submitSchema>;

import { z } from "zod";
import { INBOX_VIEWS } from "./types";
import { plainLine, plainText, uuid } from "./text";

// Strict input schemas: unknown keys are rejected, every size is bounded, nothing from the browser names an organization.

export const PAGE_SIZE_DEFAULT = 30;
export const PAGE_SIZE_MAX = 50;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;
export const SEEN_BATCH_MAX = 100;
export const NOTE_MAX = 4000;
export const QUICK_REPLY_TITLE_MAX = 60;
export const QUICK_REPLY_BODY_MAX = 1000;
export const TAG_NAME_MAX = 40;

const limit = z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT);
const cursor = z.string().min(1).max(200);

export const listQuerySchema = z.strictObject({
  view: z.enum(INBOX_VIEWS).default("all"),
  accountId: uuid.optional(),
  q: z.string().trim().min(SEARCH_MIN).max(SEARCH_MAX).optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const messagesQuerySchema = z.strictObject({ before: cursor.optional(), limit });
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;

export const notesQuerySchema = z.strictObject({ before: cursor.optional(), limit });

const status = z.enum(["OPEN", "PENDING", "RESOLVED"]);
/** `expected` is the status the browser saw: the change only applies if the conversation still has it. */
export const statusChangeSchema = z.strictObject({ to: status, expected: status });
/** `expectedAssigneeMembershipId` is who the browser saw assigned (null = nobody). */
export const assignmentSchema = z.strictObject({
  assigneeMembershipId: uuid.nullable(),
  expectedAssigneeMembershipId: uuid.nullable(),
});
export const seenSchema = z.strictObject({
  messageIds: z.array(uuid).min(1).max(SEEN_BATCH_MAX),
});
export const noteSchema = z.strictObject({ body: plainText(1, NOTE_MAX) });

export const quickReplyCreateSchema = z.strictObject({
  title: plainLine(1, QUICK_REPLY_TITLE_MAX),
  body: plainText(1, QUICK_REPLY_BODY_MAX),
});
export const quickReplyUpdateSchema = z
  .strictObject({
    title: plainLine(1, QUICK_REPLY_TITLE_MAX).optional(),
    body: plainText(1, QUICK_REPLY_BODY_MAX).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.body !== undefined || v.archived !== undefined,
    "empty",
  );
export const quickReplyListSchema = z.strictObject({
  q: z.string().trim().min(1).max(SEARCH_MAX).optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});

export const tagCreateSchema = z.strictObject({ name: plainLine(1, TAG_NAME_MAX) });
export const contactTagSchema = z.strictObject({ tagId: uuid });

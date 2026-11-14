import { z } from "zod";
import {
  ANSWER_KINDS,
  FLOW_LIMITS as L,
  ID_PATTERN,
  SUPPLEMENTARY_LIMITS as S,
  VARIABLE_TYPES,
} from "./limits";
import { textProblem } from "./text";

// Strict leaf schemas of the flow contract (V3.2 section E). Every object is a `strictObject`: an unknown field is an error,
// never silently dropped. Cross-field and cross-node rules (declared variables, destinations, types) are in validate.ts; a
// custom issue carries a diagnostic code in `params.code` (zod-diagnostics.ts reads it).

const flag = (code: string, context: Record<string, number> = {}) => ({
  code: "custom" as const,
  message: code,
  params: { code, ...context },
});

/**
 * String length is measured in UTF-16 code units (`String.length`), the contract's unit (limits.ts). zod's own `.min()` /
 * `.max()` count Unicode code points, which would let an emoji count as 1 where we count 2, so they are not used on text.
 */
const lengthIssue = (value: string, min: number, max: number) =>
  value.length < min
    ? flag("TEXT_TOO_SHORT", { min })
    : value.length > max
      ? flag("TEXT_TOO_LONG", { max })
      : null;

export const identifier = z.string().superRefine((value, ctx) => {
  if (!ID_PATTERN.test(value)) ctx.addIssue(flag("IDENTIFIER_INVALID"));
});

/** Student-facing or label text: sendable, not blank, no bidi override; `trimmed` also refuses outer whitespace. */
export const text = (max: number, options: { trimmed?: boolean } = {}) =>
  z.string().superRefine((value, ctx) => {
    const size = lengthIssue(value, 1, max);
    if (size) ctx.addIssue(size);
    if (value.length === 0) return; // already reported as too short
    const problem = textProblem(value, options);
    if (problem) ctx.addIssue(flag(problem));
  });

/** A literal string value (SET_VARIABLE, comparison): sendable and without bidi override, but may be empty or blank. */
export const literalString = z.string().superRefine((value, ctx) => {
  const size = lengthIssue(value, 0, L.variableValueMax);
  if (size) ctx.addIssue(size);
  const problem = textProblem(value, { blankAllowed: true });
  if (problem) ctx.addIssue(flag(problem));
});

const whole = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .superRefine((value, ctx) => {
      if (!Number.isSafeInteger(value)) ctx.addIssue(flag("NUMBER_NOT_INTEGER"));
    });

const coordinate = z.number().min(-S.layoutCoordinateAbsMax).max(S.layoutCoordinateAbsMax);

// ------------------------------------------------------------------------------------------------------------- parts

export const nameSchema = text(L.nameMax, { trimmed: true });

export const settingsSchema = z.strictObject({
  idleTimeoutMinutes: whole(S.idleTimeoutMinutesMin, S.idleTimeoutMinutesMax).optional(),
  maxInvalidAttempts: whole(S.maxInvalidAttemptsMin, S.maxInvalidAttemptsMax).optional(),
});

export const variableSchema = z.strictObject({
  type: z.enum(VARIABLE_TYPES),
  sensitive: z.boolean().optional(),
  maxLength: whole(1, L.variableValueMax).optional(),
});

export const layoutSchema = z.strictObject({ x: coordinate, y: coordinate });

// ----------------------------------------------------------------------------------------------------------- triggers

export const keywordTriggerSchema = z.strictObject({
  kind: z.literal("keyword"),
  words: z
    .array(text(S.keywordWordMax, { trimmed: true }))
    .min(1)
    .max(S.keywordWordsMax),
});
export const firstMessageTriggerSchema = z.strictObject({ kind: z.literal("first_message") });
export const referralSourceTriggerSchema = z.strictObject({ kind: z.literal("referral_source") });

// -------------------------------------------------------------------------------------------------------------- nodes

const optionKey = identifier;

export const messageNodeSchema = z.strictObject({
  type: z.literal("MESSAGE"),
  text: text(L.textMax),
  next: identifier,
});

export const buttonsNodeSchema = z.strictObject({
  type: z.literal("BUTTONS"),
  body: text(L.textMax),
  footer: text(L.footerMax).optional(),
  options: z
    .array(
      z.strictObject({
        key: optionKey,
        title: text(L.buttonTitleMax, { trimmed: true }),
        next: identifier,
      }),
    )
    .min(1)
    .max(L.buttonOptionsMax),
  onInvalid: identifier,
});

export const listNodeSchema = z.strictObject({
  type: z.literal("LIST"),
  body: text(L.textMax),
  buttonLabel: text(L.listButtonLabelMax, { trimmed: true }),
  footer: text(L.footerMax).optional(),
  options: z
    .array(
      z.strictObject({
        key: optionKey,
        title: text(L.listRowTitleMax, { trimmed: true }),
        description: text(L.listRowDescriptionMax).optional(),
        next: identifier,
      }),
    )
    .min(1)
    .max(L.listOptionsMax),
  onInvalid: identifier,
});

export const questionNodeSchema = z.strictObject({
  type: z.literal("QUESTION"),
  text: text(L.textMax),
  variable: identifier,
  answer: z.strictObject({
    kind: z.enum(ANSWER_KINDS),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Text answers only: refuse link-like text (see `looksLikeLink`). Absent means off. */
    rejectLinks: z.boolean().optional(),
  }),
  next: identifier,
  onInvalid: identifier,
});

/** `branches[].when` is validated structurally by validate.ts (it is recursive and depends on declared variables). */
export const conditionNodeSchema = z.strictObject({
  type: z.literal("CONDITION"),
  branches: z
    .array(z.strictObject({ when: z.unknown(), next: identifier }))
    .min(1)
    .max(S.conditionBranchesMax),
  else: identifier,
});

/** `value` is checked against the variable's type by validate.ts. */
export const setVariableNodeSchema = z.strictObject({
  type: z.literal("SET_VARIABLE"),
  variable: identifier,
  value: z.union([z.string(), z.number(), z.boolean()]),
  next: identifier,
});

export const handoverNodeSchema = z.strictObject({
  type: z.literal("HANDOVER"),
  message: text(L.textMax).optional(),
  reason: z.string(),
});

export const endNodeSchema = z.strictObject({
  type: z.literal("END"),
  message: text(L.textMax).optional(),
});

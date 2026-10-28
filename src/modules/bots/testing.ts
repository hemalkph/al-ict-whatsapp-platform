// Test support for the bots module: fixtures only. NOT part of the production module (boundaries.test.ts excludes it) and
// nothing in production code imports it. Every fixture is plain JSON built fresh per call, so tests may mutate it freely.
// The "enquiry" flow below is TEST DATA: the runtime hard-codes no wording, class, menu or branch.

import { canonicalFlowJson } from "./canonical";
import type { DiagnosticCode } from "./diagnostics";
import { FLOW_LIMITS } from "./limits";
import type { ConfigPath, Diagnostic, FlowConfig, ValidationResult } from "./types";
import { validateFlow } from "./validate";

export type Json = Record<string, unknown>;

export const codesOf = (result: ValidationResult): DiagnosticCode[] =>
  result.diagnostics.map((d) => d.code);
export const hitsOf = (result: ValidationResult, code: DiagnosticCode): Diagnostic[] =>
  result.diagnostics.filter((d) => d.code === code);
export const pathsOf = (result: ValidationResult, code: DiagnosticCode): ConfigPath[] =>
  hitsOf(result, code).map((d) => d.path);

/** The smallest valid flow: a message, an end, and the error node. */
export function minimalFlow(): Json {
  return {
    schemaVersion: 1,
    name: "Minimal",
    startNodeId: "welcome",
    errorNodeId: "to_staff",
    triggers: [{ kind: "first_message" }],
    nodes: {
      welcome: { type: "MESSAGE", text: "Hello", next: "done" },
      done: { type: "END", message: "Bye" },
      to_staff: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
    },
  };
}

/** A node map accessor for terse mutation in tests. */
export function nodesOf(flow: Json): Record<string, Json> {
  return flow.nodes as Record<string, Json>;
}

/** The same minimal flow with the supplied nodes added (and the start node optionally moved). */
export function flowWith(extra: Record<string, Json>, start?: string): Json {
  const flow = minimalFlow();
  Object.assign(nodesOf(flow), extra);
  if (start) flow.startNodeId = start;
  return flow;
}

/**
 * A realistic multilingual student-enquiry flow (Sinhala, Tamil, English): language menu, main menu list, information
 * messages that return to the menu (a legitimate loop through an input-waiting node), a registration interest question
 * sequence with a numeric answer and a branch on it, and hand-over to staff.
 */
export function enquiryFlow(): Json {
  return {
    schemaVersion: 1,
    name: "Student enquiry",
    startNodeId: "language_menu",
    errorNodeId: "to_staff",
    triggers: [
      { kind: "keyword", words: ["hi", "menu", "ආයුබෝවන්", "வணக்கம்"] },
      { kind: "first_message" },
      { kind: "referral_source" },
    ],
    settings: { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 },
    variables: {
      student_name: { type: "string", sensitive: true, maxLength: 100 },
      grade: { type: "integer" },
      wants_call: { type: "boolean" },
    },
    nodes: {
      language_menu: {
        type: "BUTTONS",
        body: "Choose your language / භාෂාව තෝරන්න / மொழியைத் தேர்ந்தெடுக்கவும் 🙂",
        footer: "A/L ICT",
        options: [
          { key: "si", title: "සිංහල", next: "si_welcome" },
          { key: "ta", title: "தமிழ்", next: "ta_welcome" },
          { key: "en", title: "English", next: "en_welcome" },
        ],
        onInvalid: "to_staff",
      },
      si_welcome: {
        type: "MESSAGE",
        text: "ආයුබෝවන්! ශ්‍රී ලංකාවේ A/L ICT පන්තියට සාදරයෙන් පිළිගනිමු.",
        next: "main_menu",
      },
      ta_welcome: {
        type: "MESSAGE",
        text: "வணக்கம்! A/L ICT வகுப்புக்கு உங்களை வரவேற்கிறோம்.",
        next: "main_menu",
      },
      en_welcome: { type: "MESSAGE", text: "Welcome to the A/L ICT classes!", next: "main_menu" },
      main_menu: {
        type: "LIST",
        body: "What would you like to know?",
        buttonLabel: "Options",
        options: [
          {
            key: "classes",
            title: "Class details",
            description: "Days, times and syllabus",
            next: "class_info",
          },
          { key: "fees", title: "Fees", next: "fee_info" },
          { key: "register", title: "I want to join", next: "ask_name" },
          { key: "staff", title: "Talk to a person", next: "to_staff" },
        ],
        onInvalid: "to_staff",
      },
      class_info: {
        type: "MESSAGE",
        text: "Details are on our page: https://example.org/classes",
        next: "main_menu",
      },
      fee_info: { type: "MESSAGE", text: "Our fee list is shared by staff.", next: "main_menu" },
      ask_name: {
        type: "QUESTION",
        text: "What is your name?",
        variable: "student_name",
        answer: { kind: "text", min: 1, max: 100 },
        next: "ask_grade",
        onInvalid: "to_staff",
      },
      ask_grade: {
        type: "QUESTION",
        text: "Which grade are you in?",
        variable: "grade",
        answer: { kind: "integer", min: 1, max: 13 },
        next: "check_grade",
        onInvalid: "to_staff",
      },
      check_grade: {
        type: "CONDITION",
        branches: [
          {
            when: {
              op: "all",
              conditions: [
                { op: "gt", variable: "grade", value: 11 },
                {
                  op: "any",
                  conditions: [
                    { op: "is_set", variable: "student_name" },
                    { op: "lt", variable: "grade", value: 14 },
                  ],
                },
              ],
            },
            next: "mark_call",
          },
          { when: { op: "in", variable: "grade", values: [9, 10, 11] }, next: "confirm" },
        ],
        else: "confirm",
      },
      mark_call: { type: "SET_VARIABLE", variable: "wants_call", value: true, next: "confirm" },
      confirm: {
        type: "MESSAGE",
        text: "Thank you, {{student_name}}. We will contact you.",
        next: "done",
      },
      to_staff: {
        type: "HANDOVER",
        reason: "student_requested",
        message: "A member of staff will reply soon.",
      },
      done: { type: "END", message: "Goodbye!" },
    },
    layout: { language_menu: { x: 0, y: 0 }, main_menu: { x: 300, y: 0 } },
  };
}

/**
 * Phase 08G-1 golden flow: the General Information bot's SHAPE with SYNTHETIC content. Every topic title and answer is test
 * data (marked "[TEST]" / "[SYNTHETIC TEST ANSWER]"), not real A/L ICT information. It must never be published: the owner has
 * not yet supplied the real FAQ topics and answers (PHASE_08G-1_APPROVAL_ADDENDUM.md).
 */
export const GENERAL_INFO_KEYWORDS = ["info", "faq"] as const;
export const GENERAL_INFO_TOPIC_KEYS = ["t1", "t2", "t3", "t4"] as const;

export function generalInfoFlow(): Json {
  const topic = (key: string, title: string, description: string) => ({
    key,
    title,
    description,
    next: `ans_${key}`,
  });
  const answer = (n: number) => ({
    type: "MESSAGE",
    text: `[SYNTHETIC TEST ANSWER ${n}] This is placeholder text for automated tests. It is not real A/L ICT information.`,
    next: "more",
  });
  return {
    schemaVersion: 1,
    name: "General information (SYNTHETIC TEST)",
    startNodeId: "welcome",
    errorNodeId: "error_to_staff",
    triggers: [{ kind: "keyword", words: [...GENERAL_INFO_KEYWORDS] }],
    settings: { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 },
    variables: {},
    nodes: {
      welcome: {
        type: "MESSAGE",
        text: "Welcome to A/L ICT classes. I can answer common questions. If I don't have the answer, I'll pass you to our staff.",
        next: "topics",
      },
      topics: {
        type: "LIST",
        body: "Which topic would you like to know about?",
        buttonLabel: "Choose a topic",
        footer: "A/L ICT",
        options: [
          topic("t1", "[TEST] Topic one", "Synthetic test topic"),
          topic("t2", "[TEST] Topic two", "Synthetic test topic"),
          topic("t3", "[TEST] Topic three", "Synthetic test topic"),
          topic("t4", "[TEST] Topic four", "Synthetic test topic"),
          { key: "other", title: "Other question", next: "needs_staff" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
        ],
        onInvalid: "invalid_to_staff",
      },
      ans_t1: answer(1),
      ans_t2: answer(2),
      ans_t3: answer(3),
      ans_t4: answer(4),
      more: {
        type: "BUTTONS",
        body: "Is there anything else I can help with?",
        options: [
          { key: "again", title: "Ask another", next: "topics" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
          { key: "done", title: "That's all", next: "bye" },
        ],
        onInvalid: "invalid_to_staff",
      },
      to_staff: {
        type: "HANDOVER",
        reason: "student_requested",
        message:
          "Sure. I've passed this chat to our staff. Please wait here for their reply. I can't say how soon.",
      },
      needs_staff: {
        type: "HANDOVER",
        reason: "needs_staff",
        message:
          "I can't help with that here, so I've passed this chat to our staff. Please wait here for their reply. I can't say how soon.",
      },
      invalid_to_staff: {
        type: "HANDOVER",
        reason: "invalid_input",
        message:
          "I couldn't understand your reply, so I've passed this chat to our staff. Please wait here for their reply.",
      },
      error_to_staff: {
        type: "HANDOVER",
        reason: "error_fallback",
        message:
          "Sorry, something went wrong on our side. I've passed this chat to our staff. Please wait here for their reply.",
      },
      bye: { type: "END", message: "Thank you. This enquiry is complete." },
    },
    layout: {},
  };
}

/**
 * Phase 08G-2 golden flow: the Class Information bot's SHAPE with SYNTHETIC content. Every class name, schedule, format and
 * joining line is test data (marked "[TEST]" / "[SYNTHETIC TEST CLASS]"), not a real A/L ICT class: the owner has not yet
 * supplied the real classes (PHASE_08G-1_APPROVAL_ADDENDUM.md). It must never be published. No fee, teacher, venue or link is
 * written anywhere, so none can be mistaken for a real claim. The shared handover and END nodes are General Information's own.
 */
export const CLASS_INFO_KEYWORDS = ["classes", "class"] as const;
export const CLASS_INFO_CLASS_KEYS = ["c1", "c2", "c3"] as const;

export function classInfoFlow(): Json {
  const shared = generalInfoFlow().nodes as Record<string, Json>;
  const cls = (key: string, title: string) => ({
    key,
    title,
    description: "Synthetic test class",
    next: `cls_${key}`,
  });
  const detail = (n: number) => ({
    type: "MESSAGE",
    text: `[SYNTHETIC TEST CLASS ${n}]\nSchedule: example day and time (test only)\nFormat: example format (test only)\nWhere or how to join: example only. This is not a real class.`,
    next: "more",
  });
  return {
    schemaVersion: 1,
    name: "Class information (SYNTHETIC TEST)",
    startNodeId: "welcome",
    errorNodeId: "error_to_staff",
    triggers: [{ kind: "keyword", words: [...CLASS_INFO_KEYWORDS] }],
    settings: { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 },
    variables: {},
    nodes: {
      welcome: {
        type: "MESSAGE",
        text: "Welcome. Here are the A/L ICT classes we have right now.",
        next: "class_list",
      },
      class_list: {
        type: "LIST",
        body: "Which class would you like to know about?",
        buttonLabel: "Choose a class",
        footer: "A/L ICT",
        options: [
          cls("c1", "[TEST] Class one"),
          cls("c2", "[TEST] Class two"),
          cls("c3", "[TEST] Class three"),
          { key: "other", title: "Class not listed", next: "needs_staff" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
        ],
        onInvalid: "invalid_to_staff",
      },
      cls_c1: detail(1),
      cls_c2: detail(2),
      cls_c3: detail(3),
      more: {
        type: "BUTTONS",
        body: "Is there anything else I can help with?",
        options: [
          { key: "again", title: "Another class", next: "class_list" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
          { key: "done", title: "That's all", next: "bye" },
        ],
        onInvalid: "invalid_to_staff",
      },
      to_staff: shared.to_staff!,
      needs_staff: shared.needs_staff!,
      invalid_to_staff: shared.invalid_to_staff!,
      error_to_staff: shared.error_to_staff!,
      bye: shared.bye!,
    },
    layout: {},
  };
}

/**
 * Phase 08G-3 golden flow: the Payment Enquiry bot's SHAPE with SYNTHETIC content. The "how to pay" and "payment dates"
 * messages are placeholders that say so and instruct nothing: no account, link, merchant, amount or deadline is written
 * anywhere (PHASE_08G-1_APPROVAL_ADDENDUM.md; D-9/D-10 data still pending). It must never be published. The bot is
 * enquiry-only: "I have paid" and "Payment problem" hand over, and no message confirms, verifies or requests a payment
 * artefact. The shared handover and END nodes are General Information's own.
 */
export const PAYMENT_ENQUIRY_KEYWORDS = ["payment", "payments", "pay"] as const;

export function paymentEnquiryFlow(): Json {
  const shared = generalInfoFlow().nodes as Record<string, Json>;
  return {
    schemaVersion: 1,
    name: "Payment enquiry (SYNTHETIC TEST)",
    startNodeId: "welcome",
    errorNodeId: "error_to_staff",
    triggers: [{ kind: "keyword", words: [...PAYMENT_ENQUIRY_KEYWORDS] }],
    settings: { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 },
    variables: {},
    nodes: {
      welcome: {
        type: "MESSAGE",
        text: "Welcome. I can share general payment information. I can't check or confirm payments. Our staff do that.",
        next: "pay_menu",
      },
      pay_menu: {
        type: "LIST",
        body: "What do you need help with?",
        buttonLabel: "Payment options",
        footer: "A/L ICT",
        options: [
          { key: "how", title: "How to pay", next: "pay_how" },
          { key: "info", title: "Payment dates", next: "pay_info" },
          { key: "verify", title: "I have paid", next: "verify_staff" },
          { key: "problem", title: "Payment problem", next: "problem_staff" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
        ],
        onInvalid: "invalid_to_staff",
      },
      pay_how: {
        type: "MESSAGE",
        text: "[SYNTHETIC TEST PAYMENT INSTRUCTIONS] This is placeholder text for automated tests. It is not a real payment instruction. Do not make any payment because of this message.\n\nPlease never send card numbers, PINs, passwords or OTP codes in this chat.",
        next: "more",
      },
      pay_info: {
        type: "MESSAGE",
        text: "[SYNTHETIC TEST PAYMENT DATES] This is placeholder text for automated tests. It is not a real payment date. Do not rely on it.",
        next: "more",
      },
      verify_staff: {
        type: "HANDOVER",
        reason: "needs_staff",
        message:
          "Thank you. Only our staff can check a payment and I can't confirm it, so I've passed this chat to them. Please wait here for their reply. I can't say how soon.",
      },
      problem_staff: {
        type: "HANDOVER",
        reason: "needs_staff",
        message:
          "I'm sorry about the problem. I've passed this chat to our staff. Please wait here for their reply. I can't say how soon.",
      },
      more: {
        type: "BUTTONS",
        body: "Is there anything else I can help with?",
        options: [
          { key: "again", title: "Ask another", next: "pay_menu" },
          { key: "staff", title: "Talk to staff", next: "to_staff" },
          { key: "done", title: "That's all", next: "bye" },
        ],
        onInvalid: "invalid_to_staff",
      },
      to_staff: shared.to_staff!,
      invalid_to_staff: shared.invalid_to_staff!,
      error_to_staff: shared.error_to_staff!,
      bye: shared.bye!,
    },
    layout: {},
  };
}

/**
 * Test-only payment-claim scanner (08G-3 P3-2). Returns the sentences in which the BOT claims a payment status. It is
 * contextual, not a word ban: a status word counts only beside a payment noun, and a sentence with explicit negation
 * ("not confirmed", "can't confirm") is allowed. Amounts, dates and bank text are NOT claims and are not judged here.
 * shortcut: sentence-level regexes, no grammar; extend the lists when a new claim phrasing is found.
 */
const PAY_NOUN = "(?:payments?|transactions?|transfers?|slips?|receipts?)";
const PAY_STATUS =
  "(?:received|confirmed|verified|approved|successful(?:ly)?|completed?|processed|cleared|accepted|settled|credited)";
const CLAIM_PATTERNS = [
  new RegExp(`\\b${PAY_NOUN}\\b.{0,40}\\b${PAY_STATUS}\\b`), // "Your payment is complete"
  new RegExp(`\\b${PAY_STATUS}\\b.{0,40}\\b${PAY_NOUN}\\b`), // "We have received your payment"
  new RegExp(`\\b(?:we|i)\\s+(?:\\w+\\s+)?(?:confirm|verify)\\b.{0,40}\\b${PAY_NOUN}\\b`),
  /\bthank you for (?:your |the )?payment/,
  /\byou(?:'ve| have) paid\b/,
];
const NEGATION = /\b(?:not|never|cannot|unable|no)\b|n't/;

export function paymentClaimViolations(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) => !NEGATION.test(sentence) && CLAIM_PATTERNS.some((re) => re.test(sentence)),
    );
}

/**
 * The bot-authored strings of a stored/sent message: a text body, or an interactive body, footer, button label, section
 * titles and row descriptions. Option and button TITLES are the student's own selectable words ("I have paid") and are
 * deliberately excluded: choosing one is not a bot claim.
 */
export function botAuthoredText(message: Json): string[] {
  if (message.type === "text") return [message.body as string];
  const p = (message.payload ?? message) as Json;
  const out = [p.body, p.footer, p.buttonLabel].filter((x): x is string => typeof x === "string");
  const rows = [
    ...((p.buttons as Json[] | undefined) ?? []),
    ...((p.sections as Json[] | undefined) ?? []).flatMap((s) => {
      if (typeof s.title === "string") out.push(s.title);
      return (s.rows as Json[]) ?? [];
    }),
  ];
  for (const r of rows) if (typeof r.description === "string") out.push(r.description);
  return out;
}

/** A deep copy (fixtures are plain JSON). */
export const clone = <T>(value: T): T => structuredClone(value);

/** A valid flow with exactly `total` nodes: welcome -> filler chain -> done, plus the error node. */
export function flowWithNodeCount(total: number): Json {
  const flow = minimalFlow();
  const nodes = nodesOf(flow);
  const fillers = total - 3;
  if (fillers < 0) throw new RangeError("a flow needs at least 3 nodes");
  nodes.welcome = { type: "MESSAGE", text: "Hello", next: fillers > 0 ? "f0" : "done" };
  for (let i = 0; i < fillers; i++) {
    nodes[`f${i}`] = { type: "MESSAGE", text: "x", next: i + 1 < fillers ? `f${i + 1}` : "done" };
  }
  return flow;
}

/** Reverses the key order of every object, recursively (the same data, written in another order). */
export function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

/** Freezes a value deeply, so a validator that mutates its input fails loudly. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * A valid flow whose NORMALIZED canonical form is exactly `target` UTF-8 bytes (ASCII padding: one character, one byte), for
 * the 65,536-byte contract boundary (ADR 0017) in the validator and in persistence (08C).
 */
export function flowOfNormalizedSize(target: number): Json {
  const FILLERS = 70;
  const small = flowWithNodeCount(FILLERS + 3);
  const bytes = (value: unknown) =>
    new TextEncoder().encode(canonicalFlowJson(value as FlowConfig)).byteLength;
  const baseNormalized = bytes(validateFlow(small).config); // every filler text is "x"
  const flow = clone(small);
  let remaining = target - baseNormalized;
  for (let i = 0; i < FILLERS && remaining > 0; i++) {
    const add = Math.min(remaining, FLOW_LIMITS.textMax - 1);
    nodesOf(flow)[`f${i}`]!.text = "x" + "a".repeat(add);
    remaining -= add;
  }
  if (remaining !== 0) throw new RangeError("target out of reach");
  return flow;
}

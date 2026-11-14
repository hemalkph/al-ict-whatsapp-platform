import { describe, expect, it } from "vitest";
import {
  simulate,
  validateFlow,
  type Scenario,
  type SendEffect,
  type SimulationResult,
} from "./index";
import { FLOW_LIMITS } from "./limits";
import { comparisonKey } from "./text";
import {
  REGISTRATION_ENQUIRY_KEYWORDS,
  REGISTRATION_SYNTHETIC_CLASSES,
  REGISTRATION_SYNTHETIC_YEARS,
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentEnquiryFlow,
  registrationClaimViolations,
  registrationEnquiryFlow,
  staffRoutingFlow,
  type Json,
} from "./testing";
import { scanUrls } from "./urls";

// Phase 08G-5: the New Registration Enquiry golden flow (SYNTHETIC test content) through the real validator and simulator.
// Database-free. Approved decisions D-14 (name, year, class only), D-15 (the confirmation is the consolidated summary, not the only readable record),
// D-16 (years pending: the range here is synthetic). Nothing here proves persistence, staff visibility or deletion.

type Ok = Extract<SimulationResult, { ok: true }>;
function run(scenario: Scenario): Ok {
  const result = simulate(registrationEnquiryFlow(), scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const tap = (optionKey: string) => ({ type: "tap", optionKey }) as const;
const say = (text: string) => ({ type: "text", text }) as const;
const nodes = () => registrationEnquiryFlow().nodes as Record<string, Json>;

const YEAR = REGISTRATION_SYNTHETIC_YEARS.min + 1;
const CLASS_ONE = REGISTRATION_SYNTHETIC_CLASSES[0][1];
const TO_CONFIRM = [tap("go"), say("Test Student"), say(String(YEAR)), tap("c1")];
const CONFIRM_TEXT = `Please check your details:\nName: Test Student\nA/L year: ${YEAR}\nClass: ${CLASS_ONE}\n\nWould you like to hand this enquiry over to our staff for review?`;
const CANCELLED =
  "Your registration enquiry has been cancelled. No registration has been completed.";

describe("Registration Enquiry: schema, triggers and variables", () => {
  it("validates with no error and no warning", () => {
    const result = validateFlow(registrationEnquiryFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("starts only on register, registration and join, with the approved settings", () => {
    const flow = validateFlow(registrationEnquiryFlow()).config!;
    expect(flow.triggers).toEqual([
      { kind: "keyword", words: ["register", "registration", "join"] },
    ]);
    expect(flow.settings).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 2 });
    expect(flow.errorNodeId).toBe("error_to_staff");
  });

  it("declares exactly the three approved variables, all sensitive", () => {
    expect(registrationEnquiryFlow().variables).toEqual({
      reg_name: { type: "string", sensitive: true, maxLength: 80 },
      al_year: { type: "integer", sensitive: true },
      class_pref: { type: "string", sensitive: true, maxLength: 40 },
    });
  });

  it("collects only name, year and class (D-14): two free-text questions plus the class list, nothing else", () => {
    const questions = Object.values(nodes()).filter((n) => n.type === "QUESTION");
    expect(questions.map((q) => q.variable)).toEqual(["reg_name", "al_year"]);
    expect(questions.map((q) => (q.answer as Json).kind)).toEqual(["text", "integer"]);
    expect(questions.map((q) => q.text).join(" ")).not.toMatch(
      /phone|whatsapp|address|school|guardian|parent|birth|national|\bid\b|nic\b|card|password|otp|pin\b|payment/i,
    );
    expect(Object.values(nodes()).some((n) => n.type === "CONDITION")).toBe(false);
  });

  it("uses a bounded synthetic year range and class list ending with the existing staff option", () => {
    expect(nodes().ask_year!.answer).toEqual({ kind: "integer", min: 2101, max: 2103 });
    const list = nodes().ask_class as Json;
    const options = list.options as Json[];
    expect(options.map((o) => o.key)).toEqual(["c1", "c2", "c3", "staff"]);
    expect(options.at(-1)).toMatchObject({ title: "Talk to staff", next: "to_staff" });
    for (const [key, title] of REGISTRATION_SYNTHETIC_CLASSES) {
      expect(title).toMatch(/^\[TEST\]/);
      expect(nodes()[`set_${key}`]).toEqual({
        type: "SET_VARIABLE",
        variable: "class_pref",
        value: title,
        next: "confirm",
      });
    }
  });

  it("reuses the shared invalid, error and staff handovers unchanged", () => {
    const shared = generalInfoFlow().nodes as Record<string, Json>;
    for (const id of ["to_staff", "invalid_to_staff", "error_to_staff"])
      expect(nodes()[id]).toEqual(shared[id]);
  });

  it("every transition stays inside the flow", () => {
    const ids = new Set(Object.keys(nodes()));
    for (const n of Object.values(nodes())) {
      const targets = [
        n.next,
        n.onInvalid,
        ...((n.options as Json[] | undefined) ?? []).map((o) => o.next),
      ];
      for (const t of targets.filter((x) => x !== undefined))
        expect(ids.has(t as string)).toBe(true);
    }
  });
});

describe("cross-bot keyword uniqueness (the 08G-0 keyword sets)", () => {
  const SETS = {
    general_info: ["info", "faq"],
    class_info: ["classes", "class"],
    payment_enquiry: ["payment", "payments", "pay"],
    staff_routing: ["staff", "agent", "human"],
    registration_enquiry: ["register", "registration", "join"],
  } as const;

  it("the Registration flow carries exactly its approved set", () => {
    expect([...REGISTRATION_ENQUIRY_KEYWORDS]).toEqual([...SETS.registration_enquiry]);
  });

  it("no keyword appears in two bots, and the real flows' triggers do not overlap", () => {
    const seen = new Map<string, string>();
    for (const [bot, words] of Object.entries(SETS))
      for (const word of words) {
        const key = comparisonKey(word);
        expect(seen.get(key), `"${word}" in ${bot} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, bot);
      }
    const keys = (flow: Json) =>
      (flow.triggers as { words?: string[] }[]).flatMap((t) => t.words ?? []).map(comparisonKey);
    const mine = new Set(keys(registrationEnquiryFlow()));
    for (const other of [
      generalInfoFlow(),
      classInfoFlow(),
      paymentEnquiryFlow(),
      staffRoutingFlow(),
      enquiryFlow(),
    ])
      for (const key of keys(other)) expect(mine.has(key)).toBe(false);
  });
});

describe("Registration Enquiry: consent", () => {
  it("welcome then consent buttons, stating plainly that this is an enquiry and not a registration", () => {
    const r = run({ steps: [] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "buttons"]);
    const consent = textOf(r.outbound[1]!);
    expect(consent).toContain("preliminary enquiry, not a registration");
    expect(consent).toContain("no payment is taken here");
    expect(consent).toContain("seen by our staff");
    const buttons = r.outbound[1]!.message;
    if (buttons.kind !== "buttons") throw new Error("expected buttons");
    expect(buttons.buttons.map((b) => b.title)).toEqual(["Continue", "Cancel"]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "consent" });
    expect(r.session!.variables).toEqual({});
  });

  it("collects nothing before consent: a name sent at the consent screen is not stored", () => {
    const r = run({ steps: [say("Test Student")] });
    expect(r.session!.variables).toEqual({});
    expect(r.outbound.filter((e) => e.message.kind === "buttons")).toHaveLength(2); // re-prompt
  });

  it("Continue asks for the name only after explicit consent", () => {
    const r = run({ steps: [tap("go")] });
    expect(textOf(r.outbound.at(-1)!)).toBe("What is your full name?");
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "ask_name" });
  });

  it("Cancel at consent ends COMPLETED with the approved wording and no variable", () => {
    const r = run({ steps: [tap("cancel")] });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "flow_end" });
    expect(textOf(r.outbound.at(-1)!)).toBe(CANCELLED);
    expect(r.session!.variables).toEqual({});
  });
});

describe("Registration Enquiry: collection and confirmation", () => {
  it("collects name, year and class and renders them in the confirmation", () => {
    const r = run({ steps: TO_CONFIRM });
    expect(r.session!.variables).toEqual({
      reg_name: "Test Student",
      al_year: YEAR,
      class_pref: CLASS_ONE,
    });
    expect(textOf(r.outbound.at(-1)!)).toBe(CONFIRM_TEXT);
    const buttons = r.outbound.at(-1)!.message;
    if (buttons.kind !== "buttons") throw new Error("expected buttons");
    expect(buttons.buttons.map((b) => b.title)).toEqual([
      "Yes, hand over",
      "Change answers",
      "Cancel",
    ]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "confirm" });
  });

  it("Yes, hand over hands over as needs_staff and does not claim a registration", () => {
    const r = run({ steps: [...TO_CONFIRM, tap("yes")] });
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: "needs_staff",
    });
    const last = r.outbound.at(-1)!;
    expect(last.terminalNotice).toBe(true);
    expect(textOf(last)).toBe(
      "Thank you. I've sent your enquiry to our staff. This is not a confirmed registration. They will contact you here. I can't say when.",
    );
  });

  it("the simulator emits the summary as an outbound message (simulator evidence only: not proof of a persisted Inbox timeline)", () => {
    const r = run({ steps: [...TO_CONFIRM, tap("yes")] });
    expect(r.outbound.map(textOf)).toContain(CONFIRM_TEXT);
  });

  it("Change answers returns to the name, overwrites every value and reconfirms", () => {
    const r = run({
      steps: [
        ...TO_CONFIRM,
        tap("edit"),
        say("Second Name"),
        say(String(REGISTRATION_SYNTHETIC_YEARS.max)),
        tap("c3"),
      ],
    });
    expect(r.session!.variables).toEqual({
      reg_name: "Second Name",
      al_year: REGISTRATION_SYNTHETIC_YEARS.max,
      class_pref: "[TEST] Class three",
    });
    const last = textOf(r.outbound.at(-1)!);
    expect(last).toContain("Name: Second Name");
    expect(last).not.toContain("Test Student");
    const sent = run({
      steps: [
        ...TO_CONFIRM,
        tap("edit"),
        say("Second Name"),
        say(String(YEAR)),
        tap("c2"),
        tap("yes"),
      ],
    });
    expect(sent.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "needs_staff" });
  });

  it("Cancel at confirmation ends COMPLETED with the approved wording and never hands over", () => {
    const r = run({ steps: [...TO_CONFIRM, tap("cancel")] });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "flow_end" });
    expect(r.session!.handoverReason ?? null).toBeNull();
    expect(textOf(r.outbound.at(-1)!)).toBe(CANCELLED);
  });

  it("Talk to staff at the class list hands over as student_requested without sending the enquiry", () => {
    const r = run({ steps: [tap("go"), say("Test Student"), say(String(YEAR)), tap("staff")] });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "student_requested" });
    expect(r.outbound.map(textOf)).not.toContain(CONFIRM_TEXT);
    expect(r.outbound.some((e) => textOf(e).includes("sent your enquiry"))).toBe(false);
  });

  it("a Sinhala name renders and round-trips", () => {
    const name = "කමල් පෙරේරා";
    const r = run({ steps: [tap("go"), say(name), say(String(YEAR)), tap("c1")] });
    expect(r.session!.variables.reg_name).toBe(name);
    expect(textOf(r.outbound.at(-1)!)).toContain(`Name: ${name}\n`);
  });

  it("the longest possible confirmation stays within the rendering limit", () => {
    const name = "W".repeat(80);
    const r = run({
      steps: [tap("go"), say(name), say(String(REGISTRATION_SYNTHETIC_YEARS.max)), tap("c3")],
    });
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "confirm" });
    expect(textOf(r.outbound.at(-1)!).length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
    // Static bound: the template plus the declared maxima of all three variables.
    const template = String(nodes().confirm!.body).replace(/\{\{\w+\}\}/g, "");
    const longestClass = Math.max(...REGISTRATION_SYNTHETIC_CLASSES.map(([, t]) => t.length));
    const bound = template.length + 80 + String(REGISTRATION_SYNTHETIC_YEARS.max).length + 40;
    expect(bound).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
    expect(longestClass).toBeLessThanOrEqual(40);
  });
});

describe("Registration Enquiry: input validation and the error contract", () => {
  it.each([
    ["too short", "A"],
    ["too long", "A".repeat(81)],
  ])("a name that is %s re-prompts once, then a valid name continues", (_label, bad) => {
    const r = run({ steps: [tap("go"), say(bad), say("Test Student")] });
    expect(r.outbound.filter((e) => textOf(e) === "What is your full name?")).toHaveLength(2);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "ask_year" });
    expect(r.session!.variables).toEqual({ reg_name: "Test Student" });
  });

  it.each([
    ["words", "next year"],
    ["a decimal", "2102.5"],
    ["below the synthetic range", String(REGISTRATION_SYNTHETIC_YEARS.min - 1)],
    ["above the synthetic range", String(REGISTRATION_SYNTHETIC_YEARS.max + 1)],
  ])("a year given as %s re-prompts and stores nothing", (_label, bad) => {
    const r = run({ steps: [tap("go"), say("Test Student"), say(bad)] });
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "ask_year" });
    expect(r.session!.variables).toEqual({ reg_name: "Test Student" });
    expect(r.outbound.filter((e) => textOf(e).startsWith("Which A/L year")).length).toBe(2);
  });

  it("a year at either synthetic boundary is accepted", () => {
    for (const y of [REGISTRATION_SYNTHETIC_YEARS.min, REGISTRATION_SYNTHETIC_YEARS.max])
      expect(
        run({ steps: [tap("go"), say("Test Student"), say(String(y))] }).session,
      ).toMatchObject({
        currentNodeId: "ask_class",
      });
  });

  it("an invalid class selection re-prompts the list; a typed class name does not set the variable", () => {
    const r = run({ steps: [tap("go"), say("Test Student"), say(String(YEAR)), say("Class one")] });
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(2);
    expect(r.session!.variables).toEqual({ reg_name: "Test Student", al_year: YEAR });
  });

  it.each([
    ["consent", [say("x"), say("y")]],
    ["name", [tap("go"), say("A"), say("B")]],
    ["year", [tap("go"), say("Test Student"), say("x"), say("y")]],
    ["class", [tap("go"), say("Test Student"), say(String(YEAR)), say("x"), say("y")]],
    ["confirm", [...TO_CONFIRM, say("x"), say("y")]],
  ])("two invalid replies at %s hand over as invalid_input", (_where, steps) => {
    const r = run({ steps });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
    expect(textOf(r.outbound.at(-1)!)).toMatch(/^I couldn't understand your reply/);
    expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
    expect(r.outbound.some((e) => textOf(e).includes("sent your enquiry"))).toBe(false);
  });

  it.each([
    ["consent", [] as const],
    ["name", [tap("go")]],
    ["year", [tap("go"), say("Test Student")]],
    ["class", [tap("go"), say("Test Student"), say(String(YEAR))]],
    ["confirm", TO_CONFIRM],
  ])("idle expiry at %s completes silently with no send", (_where, before) => {
    const r = run({
      steps: [...before, { type: "wait", ms: 30 * 60_000 }, { type: "idle_expired" }],
    });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "idle_timeout" });
    expect(r.transcript.at(-1)!.effects).toEqual([]);
    expect(r.outbound.some((e) => e.terminalNotice)).toBe(false);
    expect(r.outbound.map(textOf)).toEqual(run({ steps: [...before] }).outbound.map(textOf));
  });

  const BAD_NAMES = [
    "https://example.org/x",
    "HTTP://example.org",
    "www.example.org",
    "example.org",
    "ftp://example.org/x",
    "javascript:alert",
    "https://user:pw@example.org/",
    "Kamal see https://example.org/x",
    "Kamal example.org",
    "kamal@example.org",
    "192.168.0.1",
    "example.school",
    "example.website",
    "example.nz",
    "example.school/enrol",
    "例子.中国",
    "Kamal example.school",
    "K.M.Silva/x",
    "T.Co",
    "X.Com",
    "xn--fsqu00a.xn--fiqs8s",
  ];

  it.each(BAD_NAMES)(
    "rejects the link-like name %j at ask_name: re-prompt, not stored, not echoed",
    (name) => {
      const r = run({ steps: [tap("go"), say(name)] });
      expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "ask_name" });
      expect(r.session!.variables).toEqual({});
      expect(r.outbound.filter((e) => textOf(e) === "What is your full name?")).toHaveLength(2);
      expect(r.transcript.every((e) => e.error === undefined)).toBe(true);
      expect(r.outbound.map(textOf).join("\n")).not.toMatch(
        /example\.|例子|pw@|javascript|kamal@|silva\/|192\.168/i,
      );
      for (const t of r.outbound.map(textOf)) expect(t).not.toContain(name);
      // recovery with a valid name continues normally
      const ok = run({ steps: [tap("go"), say(name), say("Test Student")] });
      expect(ok.session).toMatchObject({ currentNodeId: "ask_year" });
      expect(ok.session!.variables).toEqual({ reg_name: "Test Student" });
    },
  );

  it.each([
    ["www.example.org", "https://example.org/x"],
    ["example.school", "example.school/enrol"],
    ["example.nz", "例子.中国"],
    ["T.Co", "xn--fsqu00a.xn--fiqs8s"],
    ["X.Com", "XN--FSQU00A.XN--FIQS8S"],
  ])(
    "two link-like names (%j, %j) hand over as invalid_input, with nothing stored or echoed",
    (first, second) => {
      const r = run({ steps: [tap("go"), say(first), say(second)] });
      expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
      expect(r.session!.variables).toEqual({});
      expect(r.outbound.map(textOf).join("\n")).not.toMatch(
        /example\.|例子|pw@|javascript|kamal@|silva\/|192\.168/i,
      );
      for (const t of r.outbound.map(textOf))
        for (const v of [first, second]) expect(t).not.toContain(v);
      expect(textOf(r.outbound.at(-1)!)).toMatch(/^I couldn't understand your reply/);
      expect(r.outbound.map(textOf)).not.toContain(CONFIRM_TEXT);
    },
  );

  it.each(BAD_NAMES)(
    "Change answers: an invalid replacement %j cannot overwrite the earlier name or be echoed",
    (name) => {
      const r = run({ steps: [...TO_CONFIRM, tap("edit"), say(name)] });
      expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "ask_name" });
      expect(r.session!.variables.reg_name).toBe("Test Student");
      expect(r.outbound.map(textOf).join("\n")).not.toMatch(
        /example\.|例子|pw@|javascript|kamal@|silva\/|192\.168/i,
      );
      for (const t of r.outbound.map(textOf)) expect(t).not.toContain(name);
      const again = run({
        steps: [
          ...TO_CONFIRM,
          tap("edit"),
          say(name),
          say("Second Name"),
          say(String(YEAR)),
          tap("c2"),
        ],
      });
      expect(again.session!.variables.reg_name).toBe("Second Name");
      expect(textOf(again.outbound.at(-1)!)).toContain("Name: Second Name\n");
      for (const t of again.outbound.map(textOf)) expect(t).not.toContain(name);
    },
  );

  it.each([
    "කමල් පෙරේරා",
    "குமார் செல்வம்",
    "Kamal Perera",
    "A.B. Perera",
    "K.M.S. Silva",
    "K.M.Silva",
    "K.M.Dev",
    "A.B.De",
    "ඩී.එම්.පෙරේරා",
    "கே.எம்.செல்வம்",
    "Anne-Marie",
    "Mary-Anne O'Brien",
    "Dr. Nimal (Jr.) de Silva",
    "Perera, K.",
    "Nimal.",
    "e\u0301lise", // not NFC on input
  ])("keeps the valid name %j", (name) => {
    const r = run({ steps: [tap("go"), say(name)] });
    expect(r.session).toMatchObject({ currentNodeId: "ask_year" });
    expect(r.session!.variables.reg_name).toBe(name.normalize("NFC"));
  });

  it("only ask_name enables the policy, and the rejected value reaches no bot-authored text", () => {
    const withPolicy = Object.entries(nodes()).filter(
      ([, n]) => ((n.answer as Json | undefined) ?? {}).rejectLinks !== undefined,
    );
    expect(withPolicy.map(([id]) => id)).toEqual(["ask_name"]);
    expect(nodes().ask_year!.answer).not.toHaveProperty("rejectLinks");
  });

  it("the shared renderer-error contract still holds for other causes (a name stored without the policy)", () => {
    const flow = registrationEnquiryFlow();
    delete ((flow.nodes as Record<string, Json>).ask_name!.answer as Json).rejectLinks;
    const result = simulate(flow, {
      steps: [tap("go"), say("ftp://example.org/x"), say(String(YEAR)), tap("c1")],
    });
    if (!result.ok) throw new Error("invalid");
    expect(result.session).toMatchObject({ handoverReason: "engine_error", endReason: "error" });
    expect(result.transcript.find((e) => e.error)!.effects).toEqual([]);
  });

  it("legacy renderer-warning contract unchanged: without the policy an https name renders (warning only) and is echoed", () => {
    const flow = registrationEnquiryFlow();
    delete ((flow.nodes as Record<string, Json>).ask_name!.answer as Json).rejectLinks;
    const result = simulate(flow, {
      steps: [tap("go"), say("example.school"), say(String(YEAR)), tap("c1")],
    });
    if (!result.ok) throw new Error("invalid");
    expect(result.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "confirm" });
    expect(textOf(result.outbound.at(-1)!)).toContain("Name: example.school\n");
  });

  it("the configured error_fallback is not the engine_error path: it needs a flow transition to the error node", () => {
    expect(nodes().error_to_staff).toMatchObject({ type: "HANDOVER", reason: "error_fallback" });
    expect(
      Object.values(nodes()).some(
        (n) => n.next === "error_to_staff" || n.onInvalid === "error_to_staff",
      ),
    ).toBe(false);
  });
});

describe("Registration Enquiry: wording, privacy and synthetic content", () => {
  const botText = () =>
    Object.values(nodes()).flatMap((n) =>
      [n.text, n.body, n.message, n.footer, n.buttonLabel].filter(
        (x): x is string => typeof x === "string",
      ),
    );

  it("never claims a registration, enrolment, payment or lead: only negated mentions", () => {
    expect(registrationClaimViolations(botText().join("\n"))).toEqual([]);
  });

  it("the claim scanner rejects affirmative claims and allows accurate negated wording", () => {
    for (const bad of [
      "Your registration is complete.",
      "You have been registered.",
      "You're enrolled in the class.",
      "Your registration was successful!",
      "We have confirmed your registration.",
      "Your place is reserved.",
    ])
      expect(registrationClaimViolations(bad), bad).not.toEqual([]);
    for (const ok of [
      "This is not a confirmed registration.",
      "No registration has been completed.",
      "It does not register you for a class, and no payment is taken here.",
    ])
      expect(registrationClaimViolations(ok), ok).toEqual([]);
  });

  it("makes no deletion, nothing-sent or erasure promise anywhere, including the cancellation", () => {
    const all = botText().join("\n");
    expect(all).not.toMatch(
      /delet|erase|remov|forgot|wiped|nothing has been sent|nothing was sent/i,
    );
    expect(nodes().cancelled!.message).toBe(CANCELLED);
    expect(nodes().cancelled!.message).not.toContain("registration was cancelled");
  });

  it("promises no time, availability, assignment or outcome beyond what the handover already allows", () => {
    const message = String(nodes().to_review!.message).replace("I can't say when.", "");
    expect(message).not.toMatch(
      /\b(soon|shortly|today|tomorrow|within|minutes?|hours?|immediately|available|assigned|enrolled|registered)\b|\d/i,
    );
  });

  it("creates no lead, tag or registration: only variables are written, and no node does anything else", () => {
    expect(new Set(Object.values(nodes()).map((n) => n.type))).toEqual(
      new Set(["MESSAGE", "BUTTONS", "QUESTION", "LIST", "SET_VARIABLE", "HANDOVER", "END"]),
    );
    expect(
      Object.values(nodes())
        .filter((n) => n.type === "SET_VARIABLE")
        .every((n) => n.variable === "class_pref"),
    ).toBe(true);
    const r = run({ steps: [...TO_CONFIRM, tap("yes")] });
    expect(Object.keys(r.session!.variables).sort()).toEqual(["al_year", "class_pref", "reg_name"]);
  });

  it("writes no URL, contact or payment detail in the configuration", () => {
    const text = botText().join("\n");
    expect(scanUrls(text)).toEqual([]);
    expect(text).not.toMatch(/https?:|www\.|@/);
  });

  it("every message obeys the text, list and button limits", () => {
    const r = run({ steps: TO_CONFIRM });
    for (const { message } of r.outbound) {
      if (message.kind === "text")
        expect(message.text.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
      if (message.kind === "buttons") {
        expect(message.body.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
        expect(message.buttons.length).toBeLessThanOrEqual(FLOW_LIMITS.buttonOptionsMax);
        for (const b of message.buttons)
          expect(b.title.length).toBeLessThanOrEqual(FLOW_LIMITS.buttonTitleMax);
      }
      if (message.kind === "list") {
        expect(message.rows.length).toBeLessThanOrEqual(FLOW_LIMITS.listOptionsMax);
        expect(message.buttonLabel.length).toBeLessThanOrEqual(FLOW_LIMITS.listButtonLabelMax);
        for (const row of message.rows)
          expect(row.title.length).toBeLessThanOrEqual(FLOW_LIMITS.listRowTitleMax);
      }
    }
  });

  it("is plainly a synthetic test flow with synthetic years and classes", () => {
    expect(registrationEnquiryFlow().name).toContain("SYNTHETIC TEST");
    expect(REGISTRATION_SYNTHETIC_YEARS.min).toBeGreaterThan(2100);
    for (const [, title] of REGISTRATION_SYNTHETIC_CLASSES) expect(title).toContain("[TEST]");
  });

  it("is deterministic: two runs of one scenario are identical", () => {
    const steps = [
      ...TO_CONFIRM,
      tap("edit"),
      say("Again"),
      say(String(YEAR)),
      tap("c2"),
      tap("yes"),
    ];
    expect(simulate(registrationEnquiryFlow(), { steps: [...steps] })).toEqual(
      simulate(registrationEnquiryFlow(), { steps: [...steps] }),
    );
  });
});

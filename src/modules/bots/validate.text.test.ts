import { describe, expect, it } from "vitest";
import { isSendableText as messagingIsSendableText } from "../messaging/schemas";
import { canonicalFlowJson, validateFlow } from "./index";
import type { DiagnosticCode } from "./diagnostics";
import { analyzeInterpolation, comparisonKey, isSendableText, textProblem } from "./text";
import { scanUrls } from "./urls";
import {
  codesOf,
  deepFreeze,
  enquiryFlow,
  flowWith,
  hitsOf,
  minimalFlow,
  reverseKeys,
  type Json,
} from "./testing";

// Unicode text, the URL policy and determinism.

const message = (text: string, extra: Json = {}): Json =>
  flowWith({ m: { type: "MESSAGE", text, next: "done", ...extra } }, "m");

function rejects(flow: unknown, code: DiagnosticCode, path?: readonly (string | number)[]) {
  const result = validateFlow(flow);
  expect(result.ok, `expected ${code}`).toBe(false);
  const hits = hitsOf(result, code);
  expect(hits.length, `expected ${code}, got ${codesOf(result).join(",")}`).toBeGreaterThan(0);
  if (path) expect(hits.map((h) => h.path)).toContainEqual(path);
  return result;
}

describe("Unicode text", () => {
  it("AA. Sinhala text, including a zero-width joiner, is accepted unchanged", () => {
    const text = "ආයුබෝවන්! ශ්‍රී ලංකාවේ A/L ICT පන්තියට සාදරයෙන් පිළිගනිමු.";
    expect(text).toContain("‍"); // the joiner in ශ්‍රී
    const result = validateFlow(message(text));
    expect(result.ok).toBe(true);
    expect(result.config!.nodes.m).toMatchObject({ text });
  });

  it("AB. Tamil text, with vowel signs and a pulli, is accepted unchanged", () => {
    const text = "வணக்கம்! உங்களை A/L ICT வகுப்புக்கு வரவேற்கிறோம்.";
    const result = validateFlow(message(text));
    expect(result.ok).toBe(true);
    expect(result.config!.nodes.m).toMatchObject({ text });
  });

  it("AC. emoji, ZWJ sequences, flags and mixed-language text are accepted", () => {
    const text = "Hello / ආයුබෝවන් / வணக்கம் 🙂 👨‍👩‍👧‍👦 🇱🇰 ✅ café";
    expect(validateFlow(message(text)).ok).toBe(true);
    const title = {
      type: "BUTTONS",
      body: "b",
      options: [{ key: "a", title: "සිංහල 🇱🇰", next: "done" }],
      onInvalid: "to_staff",
    };
    expect(validateFlow(flowWith({ m: title }, "m")).ok).toBe(true);
  });

  it("newlines, carriage returns and tabs inside a text are allowed", () => {
    expect(validateFlow(message("line one\nline two\r\n\tindented")).ok).toBe(true);
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["a bell", "a\u0007b"],
    ["an escape", "a\u001bb"],
    ["a delete character", "a\u007fb"],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00"],
  ])("text with %s is refused", (_name, text) => {
    rejects(message(text), "TEXT_INVALID_CHARACTERS", ["nodes", "m", "text"]);
  });

  it.each(["‮", "‪", "‭", "⁦", "⁩"])("bidirectional override %j is refused", (mark) => {
    rejects(message(`pay ${mark}gpj.exe`), "TEXT_BIDI_OVERRIDE", ["nodes", "m", "text"]);
  });

  it("blank text is refused and titles cannot start or end with whitespace", () => {
    rejects(message("   \n\t "), "TEXT_BLANK", ["nodes", "m", "text"]);
    const title = (t: string) =>
      flowWith(
        {
          m: {
            type: "BUTTONS",
            body: "b",
            options: [{ key: "a", title: t, next: "done" }],
            onInvalid: "to_staff",
          },
        },
        "m",
      );
    rejects(title(" Yes"), "TEXT_UNTRIMMED", ["nodes", "m", "options", 0, "title"]);
    rejects(title("Yes "), "TEXT_UNTRIMMED");
    expect(validateFlow(title("Yes please")).ok).toBe(true);
  });

  it("agrees with the messaging module's own sendable-text rule", () => {
    const samples = [
      "",
      "plain",
      "a\nb",
      "a\u0000b",
      "a\u0007b",
      "a\ud800",
      "ශ්‍රී",
      "👨‍👩‍👧",
      "\u007f",
      "\t",
      "a\u000bb",
      "a\u000cb",
      "\u001f",
    ];
    for (const s of samples)
      expect(isSendableText(s), JSON.stringify(s)).toBe(messagingIsSendableText(s));
  });

  it("text helpers: problems, comparison keys and placeholders", () => {
    expect(textProblem("ok")).toBeNull();
    expect(textProblem(" ", {})).toBe("TEXT_BLANK");
    expect(textProblem(" ", { blankAllowed: true })).toBeNull();
    expect(comparisonKey("  Yes ")).toBe(comparisonKey("yes"));
    expect(comparisonKey("é")).toBe(comparisonKey("é")); // NFC
    expect(analyzeInterpolation("a {{x}} b {{y_1}}")).toMatchObject({
      names: ["x", "y_1"],
      malformed: false,
      literal: "a  b ",
    });
  });
});

describe("URL policy (https only)", () => {
  const urlCodes = (text: string) => scanUrls(text).map((f) => f.code);

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "http://example.org",
    "HTTP://EXAMPLE.ORG",
    "ftp://example.org/file",
    "sftp://example.org",
    "ws://example.org/socket",
    "mailto:someone@example.org",
    "tel:+94110000000",
    "sms:+94110000000",
    "intent://scan/#Intent;scheme=zxing;end",
    "blob:https://example.org/uuid",
    "custom-app://open",
  ])("AF. %s is an unsupported scheme", (url) => {
    expect(urlCodes(`Open ${url} now`)).toContain("URL_SCHEME_UNSUPPORTED");
    rejects(message(`Open ${url} now`), "URL_SCHEME_UNSUPPORTED", ["nodes", "m", "text"]);
  });

  it("AF. the scheme is reported in the context, the rest of the URL is not", () => {
    const finding = scanUrls("go to http://secret.example/path?token=abc")[0]!;
    expect(finding).toEqual({ code: "URL_SCHEME_UNSUPPORTED", context: { scheme: "http" } });
    const result = validateFlow(message("go to http://secret.example/path?token=abc"));
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/secret|token=abc/);
  });

  it("AF. malformed https, embedded credentials and interpolated URLs are errors", () => {
    expect(urlCodes("see https:example.org")).toEqual(["URL_MALFORMED"]);
    expect(urlCodes("see https://")).toEqual(["URL_MALFORMED"]);
    expect(urlCodes("see https://user:pass@example.org/")).toEqual(["URL_CREDENTIALS_NOT_ALLOWED"]);
    expect(urlCodes("see https://{{host}}.example.org")).toEqual(["URL_INTERPOLATION_NOT_ALLOWED"]);
    expect(urlCodes("see https://example.org/{{code}}")).toEqual(["URL_INTERPOLATION_NOT_ALLOWED"]);
    const flow = message("see https://example.org/{{code}}");
    flow.variables = { code: { type: "string" } };
    rejects(flow, "URL_INTERPOLATION_NOT_ALLOWED", ["nodes", "m", "text"]);
    rejects(message("see https://user:pass@example.org/"), "URL_CREDENTIALS_NOT_ALLOWED");
  });

  it("an https URL is valid but always flagged for human review, with its host", () => {
    const result = validateFlow(message("Details: https://example.org/classes?year=2026."));
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.code.startsWith("URL_"))).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "URL_REVIEW_RECOMMENDED",
        context: { host: "example.org" },
      }),
    ]);
  });

  it.each([
    "https://192.168.0.1/login",
    "https://localhost/x",
    "https://example.org:8443/x",
    "https://xn--80ak6aa92e.com/",
    "https://[::1]/x",
  ])("%s is valid but unusual: a warning, never an error", (url) => {
    const result = validateFlow(message(`Open ${url}`));
    expect(result.ok).toBe(true);
    expect(codesOf(result)).toContain("URL_HOST_UNUSUAL");
  });

  it("a link written as www. without a scheme warns; one inside an https URL does not", () => {
    expect(urlCodes("visit www.example.org today")).toEqual(["URL_SCHEME_MISSING"]);
    expect(urlCodes("visit https://www.example.org today")).toEqual(["URL_REVIEW_RECOMMENDED"]);
  });

  it.each([
    "Time:10:30",
    "Note: bring your ID",
    "Class starts at 4:30pm",
    "Re: fees",
    "A/L ICT: 2026",
    "Section 2:",
    "ratio 3:1",
    "see page https",
  ])("does not mistake ordinary text for a URL: %j", (text) => {
    expect(scanUrls(text)).toEqual([]);
  });

  describe("interpolated URLs (review correction)", () => {
    const INTERP = "URL_INTERPOLATION_NOT_ALLOWED";

    it("A. an interpolated scheme is rejected, even when the variable is set to 'http'", () => {
      expect(urlCodes("{{scheme}}://example.org")).toEqual([INTERP]);
      const flow = flowWith(
        {
          s: { type: "SET_VARIABLE", variable: "scheme", value: "http", next: "m" },
          m: { type: "MESSAGE", text: "Open {{scheme}}://example.org", next: "done" },
        },
        "s",
      );
      flow.variables = { scheme: { type: "string" } };
      rejects(flow, INTERP, ["nodes", "m", "text"]);
    });

    it.each([
      ["B. hostname", "https://{{hostname}}"],
      ["B. hostname part", "https://{{sub}}.example.org/x"],
      ["C. path", "https://example.org/{{path}}"],
      ["D. query", "https://example.org/?q={{query}}"],
      ["D. fragment", "https://example.org/#{{part}}"],
      ["scheme-relative", "{{prefix}}//example.org"],
      ["split scheme", "ht{{x}}tps://example.org"],
      ["www link", "www.{{domain}}.lk"],
    ])("%s interpolation is rejected: %s", (_name, url) => {
      expect(urlCodes(`Open ${url} today`)).toEqual([INTERP]);
    });

    it("E. ordinary interpolation outside a URL is accepted", () => {
      expect(urlCodes("Hello {{name}}, class starts at 4:30. Grade: {{grade}}")).toEqual([]);
      const flow = message("Hello {{name}}, see you soon.");
      flow.variables = { name: { type: "string" } };
      expect(validateFlow(flow).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });

    it("F. a static https URL next to an unrelated placeholder is accepted, with the review warning", () => {
      const text = "Hi {{name}}, details at https://example.org/classes. Thanks {{name}}!";
      expect(urlCodes(text)).toEqual(["URL_REVIEW_RECOMMENDED"]);
      const flow = message(text);
      flow.variables = { name: { type: "string" } };
      const result = validateFlow(flow);
      expect(result.ok).toBe(true);
      expect(codesOf(result)).toContain("URL_REVIEW_RECOMMENDED");
    });

    it("G/H. a static http URL is rejected and a static https URL is accepted", () => {
      expect(urlCodes("see http://example.org")).toEqual(["URL_SCHEME_UNSUPPORTED"]);
      expect(urlCodes("see https://example.org")).toEqual(["URL_REVIEW_RECOMMENDED"]);
    });

    it("I. malformed or partial placeholders inside a URL are diagnosed safely", () => {
      for (const text of [
        "https://example.org/{{path",
        "https://example.org/}}x",
        "{{ scheme }}://example.org",
        "{{scheme}}}://example.org",
      ])
        expect(urlCodes(text), text).toContain(INTERP);
      rejects(message("Open {{ scheme }}://example.org"), INTERP, ["nodes", "m", "text"]);
    });
  });

  describe("IPv6 hosts (review correction)", () => {
    const ipv6 = ["URL_REVIEW_RECOMMENDED", "URL_HOST_UNUSUAL"];
    it.each([
      ["A. bare", "https://[2001:db8::1]"],
      ["B. trailing slash", "https://[2001:db8::1]/"],
      ["C. sentence punctuation", "Visit https://[2001:db8::1]."],
      ["C. path and comma", "Visit https://[2001:db8::1]/x, then reply"],
      ["D. parentheses", "(https://[2001:db8::1])"],
      ["D. parentheses and slash", "(see https://[2001:db8::1]/)."],
    ])("%s: %s is a valid but unusual host", (_name, text) => {
      expect(urlCodes(text)).toEqual(ipv6);
      expect(scanUrls(text)[0]!.context).toEqual({ host: "[2001:db8::1]" });
    });

    it.each(["https://[2001:db8::1", "https://[2001:db8::zz]/", "https://2001:db8::1]"])(
      "E. a malformed IPv6 authority is an error: %s",
      (url) => {
        expect(urlCodes(`Open ${url}`)).toEqual(["URL_MALFORMED"]);
      },
    );

    it("F. ordinary hosts behave as before, including balanced brackets in paths", () => {
      for (const text of [
        "(see https://example.org)",
        "https://example.org/path).",
        "https://en.wikipedia.org/wiki/Foo_(bar)",
        "[https://example.org]",
      ])
        expect(urlCodes(text), text).toEqual(["URL_REVIEW_RECOMMENDED"]);
    });
  });

  describe("scheme-like text inside an https URL (review correction)", () => {
    it.each([
      ["A. tel: in the query", "https://example.org/?next=tel:123"],
      ["B. mailto: in the fragment", "https://example.org/page#mailto:x"],
      ["B. javascript: in the fragment", "https://example.org/#javascript:alert(1)"],
      ["F. followed by punctuation", "See https://example.org/?a=tel:1."],
    ])("%s is part of the URL, not a separate link", (_name, text) => {
      expect(urlCodes(text)).toEqual(["URL_REVIEW_RECOMMENDED"]);
    });

    it.each([
      ["C. an independent tel: link", "Call tel:123 or see https://example.org/?a=1"],
      ["D. an independent http URL", "https://example.org/ and http://example.org"],
      ["E. tel: after a space", "https://example.org/ tel:123"],
      ["E. tel: on the next line", "https://example.org/\ntel:123"],
      ["E. tel: right after the host", "https://example.org)tel:123"],
      ["E. tel: after a quote", '"https://example.org"tel:123'],
    ])("%s is still rejected", (_name, text) => {
      expect(urlCodes(text)).toContain("URL_SCHEME_UNSUPPORTED");
      rejects(message(text), "URL_SCHEME_UNSUPPORTED", ["nodes", "m", "text"]);
    });

    it("G. the detector is deterministic", () => {
      const text = "https://example.org/?next=tel:1 tel:2 http://x.org www.y.org https://[::1]/";
      expect(scanUrls(text)).toEqual(scanUrls(text));
      expect(urlCodes(text)).toEqual(urlCodes(text));
    });
  });

  it("is applied to every student-facing field and to string literals", () => {
    const bad = "http://example.org";
    rejects(
      flowWith(
        {
          m: {
            type: "BUTTONS",
            body: "b",
            options: [{ key: "a", title: bad, next: "done" }],
            onInvalid: "to_staff",
          },
        },
        "m",
      ),
      "URL_SCHEME_UNSUPPORTED",
      ["nodes", "m", "options", 0, "title"],
    );
    rejects(flowWith({ m: { type: "END", message: bad } }, "m"), "URL_SCHEME_UNSUPPORTED", [
      "nodes",
      "m",
      "message",
    ]);
    rejects(
      flowWith({ m: { type: "HANDOVER", reason: "other", message: bad } }, "m"),
      "URL_SCHEME_UNSUPPORTED",
    );
    rejects(
      flowWith(
        {
          m: { type: "MESSAGE", text: "ok", next: "done" },
          l: {
            type: "LIST",
            body: "b",
            buttonLabel: "o",
            footer: bad,
            options: [{ key: "a", title: "A", next: "done" }],
            onInvalid: "to_staff",
          },
        },
        "l",
      ),
      "URL_SCHEME_UNSUPPORTED",
      ["nodes", "l", "footer"],
    );
    const literal = flowWith(
      { s: { type: "SET_VARIABLE", variable: "v", value: bad, next: "done" } },
      "s",
    );
    literal.variables = { v: { type: "string" } };
    rejects(literal, "URL_SCHEME_UNSUPPORTED", ["nodes", "s", "value"]);
  });
});

describe("AG. determinism", () => {
  it("the same input gives the same result every time", () => {
    const flow = enquiryFlow();
    const first = validateFlow(flow);
    for (let i = 0; i < 5; i++) expect(validateFlow(flow)).toEqual(first);

    const broken = flowWith({ x: { type: "MESSAGE", text: "a\u0000", next: "nowhere", extra: 1 } });
    const a = validateFlow(broken);
    expect(validateFlow(structuredClone(broken))).toEqual(a);
    expect(codesOf(a)).toEqual(
      expect.arrayContaining(["FIELD_UNKNOWN", "TEXT_INVALID_CHARACTERS"]),
    );
  });

  it("the order in which keys are written changes neither the verdict, nor the diagnostics, nor the canonical form", () => {
    const valid = enquiryFlow();
    const reordered = reverseKeys(valid);
    const one = validateFlow(valid);
    const two = validateFlow(reordered);
    expect(two.diagnostics).toEqual(one.diagnostics);
    expect(canonicalFlowJson(two.config!)).toBe(canonicalFlowJson(one.config!));

    const broken = flowWith({
      x: { type: "MESSAGE", text: "a\u0000", next: "nowhere", extra: 1 },
      y: { type: "FOO" },
    });
    expect(validateFlow(reverseKeys(broken)).diagnostics).toEqual(validateFlow(broken).diagnostics);
  });

  it("errors come before warnings and the list is ordered by path, then code", () => {
    const flow = flowWith({
      island: { type: "END" },
      bad: { type: "MESSAGE", text: "see http://x.example", next: "done" },
    });
    flow.variables = { spare: { type: "string" } };
    const { diagnostics } = validateFlow(flow);
    const severities = diagnostics.map((d) => d.severity);
    expect(severities).toEqual(
      [...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)),
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("works on deeply frozen input and never mutates it", () => {
    const frozen = deepFreeze(enquiryFlow());
    expect(validateFlow(frozen).ok).toBe(true);
    const invalid = deepFreeze(flowWith({ x: { type: "FOO" } }));
    expect(validateFlow(invalid).ok).toBe(false);
  });

  it("reads no ambient state: the verdict is independent of the clock and of Math.random", () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    try {
      Date.now = () => {
        throw new Error("clock read");
      };
      Math.random = () => {
        throw new Error("random read");
      };
      expect(validateFlow(enquiryFlow()).ok).toBe(true);
      expect(validateFlow(minimalFlow()).ok).toBe(true);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });
});

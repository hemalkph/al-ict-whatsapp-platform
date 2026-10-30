import { describe, expect, it } from "vitest";
import { parseAnswer } from "./engine";
import { validateFlow } from "./index";
import { codesOf, enquiryFlow, flowWith, nodesOf, type Json } from "./testing";
import { looksLikeLink } from "./urls";

// Phase 08G-5 correction: the opt-in `answer.rejectLinks` text-answer policy. Backward compatibility is the point: absent means
// byte-identical behaviour and canonical form.

const question = (answer: Json) =>
  flowWith(
    {
      welcome: { type: "MESSAGE", text: "Hi", next: "ask" },
      ask: {
        type: "QUESTION",
        text: "Name?",
        variable: "n",
        answer,
        next: "done",
        onInvalid: "to_staff",
      },
    },
    "welcome",
  );
const withVar = (flow: Json) => ({ ...flow, variables: { n: { type: "string", maxLength: 80 } } });

describe("rejectLinks: schema and validator", () => {
  it("is accepted on a text answer and normalized as rejectLinks: true", () => {
    const r = validateFlow(withVar(question({ kind: "text", min: 2, max: 80, rejectLinks: true })));
    expect(r.ok).toBe(true);
    expect((nodesOf(r.config as unknown as Json).ask!.answer as Json).rejectLinks).toBe(true);
  });

  it("false or absent leaves the normalized answer without the field (canonical form unchanged)", () => {
    for (const answer of [
      { kind: "text", max: 80 },
      { kind: "text", max: 80, rejectLinks: false },
    ]) {
      const r = validateFlow(withVar(question(answer)));
      expect(r.ok).toBe(true);
      expect(nodesOf(r.config as unknown as Json).ask!.answer).toEqual({ kind: "text", max: 80 });
    }
  });

  it("is refused on integer and yes_no answers and when not a boolean", () => {
    const flow = (answer: Json, type: string) => ({
      ...question(answer),
      variables: { n: { type } },
    });
    expect(
      codesOf(validateFlow(flow({ kind: "integer", rejectLinks: true }, "integer"))),
    ).toContain("ANSWER_FIELD_NOT_ALLOWED");
    expect(codesOf(validateFlow(flow({ kind: "yes_no", rejectLinks: true }, "boolean")))).toContain(
      "ANSWER_FIELD_NOT_ALLOWED",
    );
    expect(validateFlow(withVar(question({ kind: "text", max: 80, rejectLinks: "yes" }))).ok).toBe(
      false,
    );
  });

  it("existing flows are untouched: the sample enquiry flow still validates with no rejectLinks anywhere", () => {
    const r = validateFlow(enquiryFlow());
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.config)).not.toContain("rejectLinks");
  });
});

describe("rejectLinks: parseAnswer", () => {
  const plain = { kind: "text", max: 200 } as const;
  const strict = { kind: "text", max: 200, rejectLinks: true } as const;

  it("without the policy a link is an ordinary answer (legitimate URL questions are unchanged)", () => {
    for (const t of ["https://example.org/x", "example.org", "www.example.org"])
      expect(parseAnswer(plain, t)).toBe(t);
  });

  it("with the policy a link is undefined; the same bounds and normalization still apply", () => {
    expect(parseAnswer(strict, "https://example.org/x")).toBeUndefined();
    for (const t of [
      "example.school",
      "example.school/enrol",
      "例子.中国",
      "T.Co",
      "X.Com",
      "xn--fsqu00a.xn--fiqs8s",
    ]) {
      expect(parseAnswer(strict, t)).toBeUndefined();
      expect(parseAnswer(plain, t)).toBe(t);
    }
    expect(parseAnswer(strict, "K.M.Dev")).toBe("K.M.Dev");
    expect(parseAnswer(strict, "  Kamal  ")).toBe("Kamal");
    expect(parseAnswer({ ...strict, max: 3 }, "Kamal")).toBeUndefined();
  });
});

describe("looksLikeLink: boundary", () => {
  it.each([
    "https://example.org/x",
    "HTTP://example.org",
    "HtTpS://EXAMPLE.ORG",
    "ftp://example.org/x",
    "javascript:alert(1)",
    "mailto:a@b.com",
    "https://user:pw@example.org/",
    "www.example.org",
    "WWW.Example.Org",
    "example.org",
    "Example.COM",
    "sub.example.lk/path",
    "kamal@example.org",
    "Kamal example.org here",
    "my name is https://example.org",
    "10.0.0.1",
    "see 192.168.1.1 now",
    "ｅxample。org", // fullwidth letter and ideographic full stop
    "ｈｔｔｐｓ：//example.org",
    // 08G-5 P2 closure: any suffix, not a fixed list
    "example.school",
    "example.website",
    "example.nz",
    "example.zz",
    "example.school/enrol",
    "例子.中国",
    "sub.example.co.uk",
    "my-site.academy",
    "Kamal example.school here",
    "Name: example.nz.",
    "x.com",
    "X.COM",
    "t.co",
    // 08G-5 final: two-label name-cased shapes get no initials exception; ASCII IDN suffixes count
    "T.Co",
    "X.Com",
    "xn--fsqu00a.xn--fiqs8s",
    "XN--FSQU00A.XN--FIQS8S",
    "Xn--Fsqu00a.Xn--Fiqs8s",
    "example.xn--fiqs8s",
    "xn--fsqu00a.xn--fiqs8s/enrol",
    "Kamal xn--fsqu00a.xn--fiqs8s",
    "A.B.Perera.lk", // last label lowercase: not name-cased
    "K.M.Silva/x", // a path wins over the initials exception
    "K.M.Dev:8080",
    "A.B.De?x=1",
    "example.org#top",
    "කමල්.ලංකා/x",
  ])("link-like: %j", (v) => expect(looksLikeLink(v)).toBe(true));

  it.each([
    "කමල් පෙරේරා",
    "குமார் செல்வம்",
    "Kamal Perera",
    "A.B. Perera",
    "K.M.Silva",
    "K.M.S. Silva",
    "J. R. R. Tolkien",
    "Mary-Anne O'Brien",
    "Dr. Nimal (Jr.) de Silva",
    "Perera, K.",
    "Nimal.",
    "K.M.Dev",
    "A.B.De",
    "A.B.C.Perera",
    "Anne-Marie",
    "O'Brien",
    "ඩී.එම්.පෙරේරා", // Sinhala dotted initials
    "கே.எம்.செல்வம்", // Tamil dotted initials
    "Kamal Ph.D.",
    "Nimal e.g. Perera",
    "Nimal...Perera",
    "Data Silva", // 'data' without a colon
    "Tel Aviv Cohen",
    "1.5",
    "12.34.56",
  ])("not link-like: %j", (v) => expect(looksLikeLink(v)).toBe(false));

  it("intentional trade-offs (documented): multi-initial shapes pass even when they spell a domain; a single joined initial and joined words are refused", () => {
    expect(looksLikeLink("A.B.Com")).toBe(false);
    expect(looksLikeLink("K.Perera")).toBe(true);
    expect(looksLikeLink("K. Perera")).toBe(false);
    expect(looksLikeLink("Dr.Nimal")).toBe(true);
    expect(looksLikeLink("Nimal.Perera")).toBe(true);
  });

  it("known limitation (not claimed): spaced or bracketed dots are not recognised", () => {
    expect(looksLikeLink("example dot org")).toBe(false);
    expect(looksLikeLink("example [.] org")).toBe(false);
  });
});

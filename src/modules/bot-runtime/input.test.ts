import { describe, expect, it } from "vitest";
import { toStudentInput, type InboundMessageRow } from "./input";

const msg = (over: Partial<InboundMessageRow>): InboundMessageRow => ({
  type: "TEXT",
  body: null,
  content: null,
  replyToWamid: null,
  ...over,
});
const ID = "b1.AbCdEfGhIjKlMnOpQrStUv.fees";
const reply = (subtype: string, extra: Partial<InboundMessageRow> = {}) =>
  msg({ type: "INTERACTIVE", body: "Fees", content: { subtype, id: ID, title: "Fees" }, ...extra });

describe("a persisted message as the engine's input to a LIVE session", () => {
  it("TEXT is text, with the body unchanged", () => {
    expect(toStudentInput(msg({ body: "  Hello  " }), null)).toEqual({
      kind: "text",
      text: "  Hello  ",
    });
    expect(toStudentInput(msg({ body: "" }), null)).toEqual({ kind: "text", text: "" });
  });

  it("a TEXT row without a body cannot answer anything: other", () => {
    expect(toStudentInput(msg({ body: null }), null)).toEqual({ kind: "other" });
  });

  it("a button reply and a list reply are interactive, with the id passed through unchanged", () => {
    expect(toStudentInput(reply("button_reply"), "wamid.P")).toEqual({
      kind: "interactive",
      subtype: "button_reply",
      replyId: ID,
      contextMismatch: false,
    });
    expect(toStudentInput(reply("list_reply"), null)).toMatchObject({
      subtype: "list_reply",
      replyId: ID,
    });
  });

  it("BUTTON (a template quick reply) is other as an input to a live session", () => {
    expect(
      toStudentInput(
        msg({ type: "BUTTON", body: "Yes", content: { payload: "P", text: "Yes" } }),
        null,
      ),
    ).toEqual({ kind: "other" });
  });

  it("an interactive row that cannot be a reply is other: no id, a non-string id, an empty id, another subtype, no content", () => {
    expect(
      toStudentInput(
        msg({ type: "INTERACTIVE", content: { subtype: "button_reply", title: "x" } }),
        null,
      ),
    ).toEqual({ kind: "other" });
    expect(
      toStudentInput(
        msg({ type: "INTERACTIVE", content: { subtype: "button_reply", id: 7 } }),
        null,
      ),
    ).toEqual({ kind: "other" });
    expect(
      toStudentInput(
        msg({ type: "INTERACTIVE", content: { subtype: "button_reply", id: "" } }),
        null,
      ),
    ).toEqual({ kind: "other" });
    expect(
      toStudentInput(msg({ type: "INTERACTIVE", content: { subtype: "nfm_reply", id: ID } }), null),
    ).toEqual({ kind: "other" });
    expect(toStudentInput(msg({ type: "INTERACTIVE", content: null }), null)).toEqual({
      kind: "other",
    });
    expect(toStudentInput(msg({ type: "INTERACTIVE", content: "oops" }), null)).toEqual({
      kind: "other",
    });
    expect(toStudentInput(msg({ type: "INTERACTIVE", content: [ID] }), null)).toEqual({
      kind: "other",
    });
  });

  it("an over-long or malformed id is passed through untouched: the engine owns the grammar and reports malformed_reply", () => {
    const long = `b1.${"A".repeat(22)}.${"k".repeat(500)}`;
    expect(
      toStudentInput(
        reply("button_reply", { content: { subtype: "button_reply", id: long } }),
        null,
      ),
    ).toMatchObject({
      replyId: long,
    });
    expect(
      toStudentInput(
        reply("button_reply", { content: { subtype: "button_reply", id: "not-a-bot-id" } }),
        null,
      ),
    ).toMatchObject({
      replyId: "not-a-bot-id",
    });
  });

  it("every other type never reaches the engine", () => {
    for (const type of [
      "IMAGE",
      "VIDEO",
      "AUDIO",
      "DOCUMENT",
      "STICKER",
      "LOCATION",
      "CONTACT",
      "FLOW",
      "TEMPLATE",
      "SYSTEM",
      "REACTION",
      "UNKNOWN",
      "NEW_TYPE",
      "text",
      "",
    ])
      expect(toStudentInput(msg({ type, body: "x" }), null), type).toBeNull();
  });
});

describe("reply context", () => {
  it("no context changes nothing", () => {
    expect(toStudentInput(reply("button_reply", { replyToWamid: null }), "wamid.P")).toMatchObject({
      contextMismatch: false,
    });
    expect(toStudentInput(reply("button_reply", { replyToWamid: null }), null)).toMatchObject({
      contextMismatch: false,
    });
  });
  it("a context equal to the prompt's wamid matches", () => {
    expect(
      toStudentInput(reply("button_reply", { replyToWamid: "wamid.P" }), "wamid.P"),
    ).toMatchObject({ contextMismatch: false });
  });
  it("a different context is a mismatch", () => {
    expect(
      toStudentInput(reply("button_reply", { replyToWamid: "wamid.OTHER" }), "wamid.P"),
    ).toMatchObject({ contextMismatch: true });
  });
  it("a context when the prompt's wamid is unknown cannot match", () => {
    expect(toStudentInput(reply("list_reply", { replyToWamid: "wamid.X" }), null)).toMatchObject({
      contextMismatch: true,
    });
  });
  it("the context never affects a text or other input", () => {
    expect(toStudentInput(msg({ body: "hi", replyToWamid: "wamid.X" }), "wamid.P")).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(toStudentInput(msg({ type: "BUTTON", replyToWamid: "wamid.X" }), "wamid.P")).toEqual({
      kind: "other",
    });
  });
});

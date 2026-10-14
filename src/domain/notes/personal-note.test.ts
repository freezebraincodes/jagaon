import { describe, expect, it } from "vitest";
import { NOTE_THEME_KEYS, isNoteThemeKey } from "./note-themes";
import { personalNotePayloadSchema, personalNoteRevisionSchema, type PersonalNotePayload } from "./personal-note";

/** Owner decision 2026-10-14 (My notes): the PERSONAL_NOTE payload and revision schemas. Synthetic values only. */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-10-14T02:00:00.000Z";

const base: PersonalNotePayload = {
  text: "I felt tired after a short night.",
  language: "en-SG",
  feelingCues: ["tired"],
  turns: [],
  themes: ["SLEEP"],
  aiUsed: false,
  promptVersion: null,
  careQuestionRef: null,
};

const parse = (overrides: Partial<Record<keyof PersonalNotePayload, unknown>>) => personalNotePayloadSchema.safeParse({ ...base, ...overrides });

function revision(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: "PERSONAL_NOTE",
    recordId: ID(1),
    revisionId: ID(2),
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: AT,
    revisionCreatedAt: AT,
    temporal: { kind: "ATEMPORAL" },
    provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" },
    auditEventId: ID(3),
    transactionId: ID(4),
    payload,
    ...overrides,
  };
}

describe("note themes", () => {
  it("is the closed owner list", () => {
    expect(NOTE_THEME_KEYS).toEqual(["SLEEP", "HEALTH_OR_SUGAR", "MEDICINES", "FAMILY", "WORK", "MONEY", "FOOD", "MOOD", "OTHER"]);
    expect(Object.isFrozen(NOTE_THEME_KEYS)).toBe(true);
    expect(isNoteThemeKey("SLEEP")).toBe(true);
    expect(isNoteThemeKey("STRESS")).toBe(false);
    expect(isNoteThemeKey(3)).toBe(false);
  });
});

describe("personal note payload", () => {
  it("accepts a plain note and a full AI-assisted note", () => {
    expect(parse({}).success).toBe(true);
    expect(
      parse({
        language: "zh-SG",
        text: "最近睡得不好。",
        feelingCues: ["tired", "worried", "worn-out", "low_energy"],
        turns: [
          { role: "PATIENT", text: "I could not sleep.", source: "PATIENT" },
          { role: "JAGAON_QUESTION", text: "What kept you awake?", source: "AI_VALIDATED" },
          { role: "JAGAON_KIND_SENTENCE", text: "That sounds hard.", source: "REVIEWED_BANK" },
        ],
        themes: ["SLEEP", "MOOD"],
        aiUsed: true,
        promptVersion: "feelings-chat.1",
        careQuestionRef: { recordType: "CARE_QUESTION", recordId: ID(7), revisionId: ID(8) },
      }).success,
    ).toBe(true);
    expect(parse({ language: "und", themes: [], feelingCues: [] }).success).toBe(true);
  });

  it("bounds the text to 1–1000 code points with no surrounding space", () => {
    expect(parse({ text: "" }).success).toBe(false);
    expect(parse({ text: " padded" }).success).toBe(false);
    expect(parse({ text: "😀".repeat(1000) }).success).toBe(true);
    expect(parse({ text: "a".repeat(1001) }).success).toBe(false);
  });

  it("requires a prompt version when AI was used, and refuses an AI line without it", () => {
    expect(parse({ aiUsed: true, promptVersion: null }).success).toBe(false);
    expect(parse({ aiUsed: true, promptVersion: "feelings-chat.1" }).success).toBe(true);
    expect(parse({ aiUsed: false, promptVersion: null }).success).toBe(true);
    expect(parse({ aiUsed: false, turns: [{ role: "JAGAON_QUESTION", text: "How are you?", source: "AI_VALIDATED" }] }).success).toBe(false);
    expect(parse({ aiUsed: false, turns: [{ role: "JAGAON_QUESTION", text: "How are you?", source: "REVIEWED_BANK" }] }).success).toBe(true);
  });

  it("allows only unique themes from the closed list", () => {
    expect(parse({ themes: NOTE_THEME_KEYS }).success).toBe(true);
    expect(parse({ themes: ["SLEEP", "SLEEP"] }).success).toBe(false);
    expect(parse({ themes: ["STRESS"] }).success).toBe(false);
  });

  it("keeps at most seven turns, each 1–1000 code points, with a source that matches the speaker", () => {
    const turn = { role: "PATIENT", text: "Okay.", source: "PATIENT" };
    expect(parse({ turns: Array(7).fill(turn) }).success).toBe(true);
    expect(parse({ turns: Array(8).fill(turn) }).success).toBe(false);
    expect(parse({ turns: [{ ...turn, text: "" }] }).success).toBe(false);
    expect(parse({ turns: [{ ...turn, text: "a".repeat(1001) }] }).success).toBe(false);
    expect(parse({ turns: [{ role: "PATIENT", text: "Okay.", source: "REVIEWED_BANK" }] }).success).toBe(false);
    expect(parse({ turns: [{ role: "JAGAON_QUESTION", text: "Okay?", source: "PATIENT" }] }).success).toBe(false);
    expect(parse({ turns: [{ ...turn, extra: true }] }).success).toBe(false);
  });

  it("keeps at most twelve plain lowercase feeling cues", () => {
    expect(parse({ feelingCues: Array.from({ length: 12 }, () => "tired") }).success).toBe(true);
    expect(parse({ feelingCues: Array.from({ length: 13 }, () => "tired") }).success).toBe(false);
    for (const cue of ["Tired", "tired!", "two words", "", "a".repeat(33), "-tired"]) expect(parse({ feelingCues: [cue] }).success).toBe(false);
  });

  it("refuses unknown keys, other languages and a reference to another record type", () => {
    expect(personalNotePayloadSchema.safeParse({ ...base, mood: "low" }).success).toBe(false);
    expect(parse({ language: "en" }).success).toBe(false);
    expect(parse({ careQuestionRef: { recordType: "APPOINTMENT", recordId: ID(7), revisionId: ID(8) } }).success).toBe(false);
  });
});

describe("personal note revision", () => {
  it("accepts one patient-entered CREATE revision", () => {
    expect(personalNoteRevisionSchema.safeParse(revision(base)).success).toBe(true);
  });

  it("binds AI assistance in the provenance to aiUsed", () => {
    const ai = { ...base, aiUsed: true, promptVersion: "feelings-chat.1" };
    const assisted = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "AI_ASSISTED" };
    expect(personalNoteRevisionSchema.safeParse(revision(ai, { provenance: assisted })).success).toBe(true);
    expect(personalNoteRevisionSchema.safeParse(revision(ai)).success).toBe(false);
    expect(personalNoteRevisionSchema.safeParse(revision(base, { provenance: assisted })).success).toBe(false);
  });

  it("refuses other actions, chains, temporal kinds and system provenance", () => {
    expect(personalNoteRevisionSchema.safeParse(revision(base, { action: "CORRECT" })).success).toBe(false);
    expect(personalNoteRevisionSchema.safeParse(revision(base, { revisionNumber: 2, previousRevisionId: ID(9) })).success).toBe(false);
    expect(personalNoteRevisionSchema.safeParse(revision(base, { schemaVersion: 2 })).success).toBe(false);
    expect(personalNoteRevisionSchema.safeParse(revision(base, { temporal: { kind: "POINT" } })).success).toBe(false);
    expect(personalNoteRevisionSchema.safeParse(revision(base, { provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" } })).success).toBe(false);
  });
});

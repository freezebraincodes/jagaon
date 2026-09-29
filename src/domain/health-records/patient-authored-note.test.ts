import { describe, it, expect } from "vitest";
import {
  patientAuthoredNoteSchema,
  type PatientAuthoredNote,
} from "./patient-authored-note";

describe("patientAuthoredNoteSchema", () => {
  it("accepts an English note", () => {
    const result = patientAuthoredNoteSchema.parse({
      text: "Feeling good today",
      language: "en-SG",
    });
    expect(result.language).toBe("en-SG");
  });

  it("accepts a Chinese note", () => {
    const result = patientAuthoredNoteSchema.parse({
      text: "今天感觉不错",
      language: "zh-SG",
    });
    expect(result.language).toBe("zh-SG");
  });

  it("accepts an und language note", () => {
    const result = patientAuthoredNoteSchema.parse({
      text: "Some text",
      language: "und",
    });
    expect(result.language).toBe("und");
  });

  it("accepts a 1-code-point note", () => {
    expect(patientAuthoredNoteSchema.parse({ text: "A", language: "en-SG" }).text).toBe("A");
  });

  it("accepts a 1000-code-point note", () => {
    const text = "a".repeat(1000);
    expect(patientAuthoredNoteSchema.parse({ text, language: "en-SG" }).text).toBe(text);
  });

  it("rejects an empty note", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "", language: "en-SG" }),
    ).toThrow();
  });

  it("rejects a note exceeding 1000 code points", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "a".repeat(1001), language: "en-SG" }),
    ).toThrow();
  });

  it("rejects leading whitespace", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: " hello", language: "en-SG" }),
    ).toThrow();
  });

  it("rejects trailing whitespace", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "hello ", language: "en-SG" }),
    ).toThrow();
  });

  it("counts code points not UTF-16 code units", () => {
    const emoji500 = "😀".repeat(500);
    expect(patientAuthoredNoteSchema.parse({ text: emoji500, language: "en-SG" }).text).toBe(emoji500);
    const emoji1001 = "😀".repeat(1001);
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: emoji1001, language: "en-SG" }),
    ).toThrow();
  });

  it("rejects an invalid language", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "Hello", language: "en-US" }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "Hello", language: "en-SG", extra: true }),
    ).toThrow();
  });

  it("rejects a translatedText field", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({
        text: "Hello",
        language: "en-SG",
        translatedText: "你好",
      }),
    ).toThrow();
  });

  it("rejects an inferredLanguage field", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({
        text: "Hello",
        language: "en-SG",
        inferredLanguage: "zh-SG",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only note text", () => {
    expect(() =>
      patientAuthoredNoteSchema.parse({ text: "   ", language: "en-SG" }),
    ).toThrow();
  });
});
// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MMOL_CONFIRMATION_TRIGGER,
  MMOL_ENTRY_MAX_LENGTH,
  formatMmolEntry,
  isFormattedMmolEntry,
  isMmolEntryTyping,
  isMmolEntryValue,
  mmolEntryNeedsConfirmation,
} from "./glucose-entry-format";

describe("CR-11 shared mmol/L new-entry format (design v3.1 §3)", () => {
  it("AC-8: formats a completed entry to exactly one decimal (formatting only)", () => {
    expect(["0", "9", "9.", "9.2", "60", "60.0", "100", "999.5", "1234.5", "0.0"].map(formatMmolEntry)).toEqual(["0.0", "9.0", "9.0", "9.2", "60.0", "60.0", "100.0", "999.5", "1234.5", "0.0"]);
    for (const formatted of ["0.0", "9.0", "9.2", "60.0", "1234.5"]) expect(isFormattedMmolEntry(formatted), formatted).toBe(true);
    for (const raw of ["0", "9", "60", "9.25", "6.80"]) expect(isFormattedMmolEntry(raw), raw).toBe(false);
  });

  it("AC-10: never rounds or truncates: more than one decimal is refused, never 9.2 or 9.3", () => {
    for (const text of ["9.25", "60.00", "6.80", "6.85", "60.123"]) {
      expect(formatMmolEntry(text), text).toBeNull();
      expect(isMmolEntryValue(text), text).toBe(false);
      expect(isMmolEntryTyping(text), text).toBe(false);
    }
  });

  it("AC-11: no hidden ceiling: 100, 999.5 and 1234.5 are valid entries", () => {
    for (const text of ["100", "999.5", "1234.5", "9999.9", "50.1", "60"]) expect(isMmolEntryValue(text), text).toBe(true);
  });

  it("AC-12: the technical bound (R-1, R-7): 1–4 integer digits, no sign, exponent, letters or leading zeros", () => {
    for (const text of ["-5", "1e3", "abc", "060", "12345", "+5", "6,8", " 6.8", "6.8 ", ".5", "6..5", ""]) expect(isMmolEntryValue(text), JSON.stringify(text)).toBe(false);
    expect(MMOL_ENTRY_MAX_LENGTH).toBe(6);
  });

  it("AC-9: typing and paste accept only a prefix of a valid value: one separator, one fractional digit", () => {
    for (const text of ["", "0", "0.", "0.5", "9", "9.", "9.2", "60", "1234", "1234.", "1234.5"]) expect(isMmolEntryTyping(text), JSON.stringify(text)).toBe(true);
    for (const text of ["9.25", "60.00", "6..5", "9.2.", "..", ".", "06", "060", "12345", "-5", "1e3", "abc", "1234.56"]) expect(isMmolEntryTyping(text), JSON.stringify(text)).toBe(false);
  });

  it("AC-7 / trigger: above 50 or zero needs confirmation; 50 is a trigger only, never a limit", () => {
    expect(MMOL_CONFIRMATION_TRIGGER).toBe(50);
    expect(["0", "0.0", "0.", "50.1", "60", "100", "1234.5"].map(mmolEntryNeedsConfirmation)).toEqual([true, true, true, true, true, true, true]);
    expect(["0.1", "6.8", "50", "50.0", "9.25", ""].map(mmolEntryNeedsConfirmation)).toEqual([false, false, false, false, false, false]);
  });
});

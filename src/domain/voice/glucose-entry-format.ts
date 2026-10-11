/**
 * CR-11 (design v3.1 §1–§3; owner decisions R-1, R-4, R-7, 2026-10-11): the ONE technical format of a NEW mmol/L glucose entry, shared by
 * manual entry (typing, the keypad and paste), the voice extractor and card, the voice review contract and both save paths, so every
 * path accepts and refuses exactly the same text.
 *
 * - A completed value is a plain decimal: 1–4 integer digits with no leading zero except "0" itself (R-1), and at most ONE digit after
 *   a single "." (owner formatting rule). No sign (R-7), exponent, space, comma or other character.
 * - New entries are stored and shown with exactly one decimal: "0" → "0.0", "9" → "9.0", "9." → "9.0", "9.2" → "9.2", "60" → "60.0".
 *   Adding ".0" is formatting only; nothing is ever rounded or truncated: "9.25" or "60.00" is refused, never turned into 9.2 or 9.3.
 * - While typing, a prefix of a valid value is accepted ("", "9", "9.", "9.2"); anything else is refused as a whole (never trimmed).
 * - Confirmation trigger, NOT a maximum: a value above 50 mmol/L, or zero, needs the person's explicit "Save as shown". 50 is never a
 *   save limit and there is no clinical maximum; the technical bound is the digit count only.
 * Historical records are never re-validated or rewritten with these rules (they are display-only elsewhere).
 * It lives in the voice domain because the voice domain may import only its own siblings (src/voice/voice-import-boundary.test.ts);
 * it is pure and imports nothing, and manual entry uses the very same functions.
 */
export const MMOL_ENTRY_MAX_LENGTH = 6;
/** Above this value (or at zero) a reading needs explicit confirmation. A verification trigger only, never a save limit. */
export const MMOL_CONFIRMATION_TRIGGER = 50;

const COMPLETE = /^(?:0|[1-9]\d{0,3})(?:\.\d)?$/;
const COMPLETE_WITH_SEPARATOR = /^(?:0|[1-9]\d{0,3})\.$/;
const TYPING = /^(?:(?:0|[1-9]\d{0,3})(?:\.\d?)?)?$/;
const STORED = /^(?:0|[1-9]\d{0,3})\.\d$/;

/** A complete mmol/L value as typed or spoken (≤ 4 integer digits, ≤ 1 decimal), before formatting. */
export function isMmolEntryValue(text: string): boolean {
  return typeof text === "string" && COMPLETE.test(text);
}

/** The exact stored form of a new mmol/L entry: exactly one decimal ("60.0", "0.0", "9.2"). */
export function isFormattedMmolEntry(text: string): boolean {
  return typeof text === "string" && STORED.test(text);
}

/** Text the field may hold while the person is still typing or after a paste (a prefix of a valid value). */
export function isMmolEntryTyping(text: string): boolean {
  return typeof text === "string" && text.length <= MMOL_ENTRY_MAX_LENGTH && TYPING.test(text);
}

/**
 * The completed entry with exactly one decimal, or null when the text is not a valid entry. Formatting only: "9" → "9.0", "9." → "9.0";
 * "9.25" → null (never rounded or truncated).
 */
export function formatMmolEntry(text: string): string | null {
  if (typeof text !== "string") return null;
  if (COMPLETE_WITH_SEPARATOR.test(text)) return `${text}0`;
  if (!COMPLETE.test(text)) return null;
  return text.includes(".") ? text : `${text}.0`;
}

/** Whether a valid entry needs explicit confirmation before saving: above 50 mmol/L, or zero. */
export function mmolEntryNeedsConfirmation(text: string): boolean {
  const formatted = formatMmolEntry(text);
  if (formatted === null) return false;
  const value = Number(formatted);
  return value === 0 || value > MMOL_CONFIRMATION_TRIGGER;
}

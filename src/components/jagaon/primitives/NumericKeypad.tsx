"use client";

/**
 * On-screen number pad (frame 02). Every key is a real button that edits the
 * same value as the text input, so typing, the device keyboard and the pad
 * all stay in sync; nothing here interprets the number.
 *
 * CR-11: the screen may pass `accept` (the same validator as typing and paste);
 * a key that would make the value unacceptable (a second ".", a second digit
 * after it, a leading zero, too many digits) changes nothing and calls
 * `onRefused`, so the screen can say so. `appendBase` is the text a new key is
 * appended to when the field shows a completion-formatted value ("9" shown as
 * "9.0"), so formatting never disrupts editing; Delete removes the last shown
 * character.
 */
type NumericKeypadProps = {
  label: string;
  deleteLabel: string;
  decimalLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** Maximum characters the field accepts. */
  maxLength?: number;
  /** CR-11: whether the value after a key press is acceptable (else nothing changes and `onRefused` is called). */
  accept?: (next: string) => boolean;
  onRefused?: () => void;
  /** CR-11: the text new keys are appended to (what was typed before completion formatting); defaults to `value`. */
  appendBase?: string;
};

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function NumericKeypad({
  label,
  deleteLabel,
  decimalLabel,
  value,
  onChange,
  maxLength = 5,
  accept,
  onRefused,
  appendBase,
}: NumericKeypadProps) {
  function press(key: string) {
    const base = appendBase ?? value;
    if (key === "." && base.includes(".")) return onRefused?.();
    const next = key === "." && base === "" ? "0." : base + key;
    if (next.length > maxLength || (accept && !accept(next))) return onRefused?.();
    onChange(next);
  }

  return (
    <div className="keypad" role="group" aria-label={label}>
      {DIGITS.map((digit) => (
        <button key={digit} type="button" className="keypad-key" onClick={() => press(digit)}>
          {digit}
        </button>
      ))}
      <button type="button" className="keypad-key" aria-label={decimalLabel} onClick={() => press(".")}>
        <span aria-hidden="true">.</span>
      </button>
      <button type="button" className="keypad-key" onClick={() => press("0")}>
        0
      </button>
      <button
        type="button"
        className="keypad-key"
        aria-label={deleteLabel}
        onClick={() => onChange(value.slice(0, -1))}
      >
        <svg width="34" height="26" viewBox="0 0 34 26" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M11 2h20v22H11L2 13z" />
          <path d="M16 8l10 10M26 8L16 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

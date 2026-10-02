"use client";

/**
 * On-screen number pad (frame 02). Every key is a real button that edits the
 * same value as the text input, so typing, the device keyboard and the pad
 * all stay in sync; nothing here interprets the number.
 */
type NumericKeypadProps = {
  label: string;
  deleteLabel: string;
  decimalLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** Maximum characters the field accepts. */
  maxLength?: number;
};

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function NumericKeypad({
  label,
  deleteLabel,
  decimalLabel,
  value,
  onChange,
  maxLength = 5,
}: NumericKeypadProps) {
  function press(key: string) {
    if (key === "." && value.includes(".")) return;
    if (value.length >= maxLength) return;
    onChange(key === "." && value === "" ? "0." : value + key);
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

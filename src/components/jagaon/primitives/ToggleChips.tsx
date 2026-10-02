"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "./Icons";

export type ToggleChipOption<T extends string> = { value: T; label: string };

/**
 * Pressable chips (aria-pressed). Single-select groups can be cleared by
 * pressing the selected chip again; multi-select groups toggle each chip.
 */
export function ToggleChips<T extends string>({
  label,
  heading,
  options,
  selected,
  onToggle,
  aside,
}: {
  label: string;
  heading?: ReactNode;
  options: readonly ToggleChipOption<T>[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  aside?: ReactNode;
}) {
  return (
    <div className="toggle-chips" role="group" aria-label={label}>
      {heading || aside ? (
        <div className="toggle-chips-head">
          {heading}
          {aside}
        </div>
      ) : null}
      <div className="choice-options">
        {options.map((option) => {
          const pressed = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className="chip"
              aria-pressed={pressed}
              onClick={() => onToggle(option.value)}
            >
              {option.label}
              {pressed ? <CheckIcon size={18} className="icon chip-check" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useId } from "react";
import { CheckIcon } from "./Icons";

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  /** Optional secondary line (used by card-style choices). */
  detail?: string;
};

type ChoiceGroupProps<T extends string> = {
  legend: string;
  /** Visually hide the legend when a surrounding heading already names it. */
  legendHidden?: boolean;
  options: readonly ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  variant?: "chip" | "card" | "segmented";
  error?: string;
};

/**
 * Native radio inputs styled as v1 chips, cards or a segmented control.
 * Arrow keys, Space and screen-reader radio semantics all come from the
 * browser; the visual state follows `:checked` and `:focus-visible`.
 */
export function ChoiceGroup<T extends string>({
  legend,
  legendHidden = false,
  options,
  value,
  onChange,
  variant = "chip",
  error,
}: ChoiceGroupProps<T>) {
  const name = useId();
  const errorId = `${name}-error`;
  return (
    <fieldset
      className={`choice-group choice-group--${variant}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className={legendHidden ? "sr-only" : "eyebrow"}>{legend}</legend>
      <div className="choice-options">
        {options.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              className="choice-input"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="choice-face">
              <span className="choice-text">
                <span className="choice-label">{option.label}</span>
                {option.detail ? (
                  <span className="choice-detail">{option.detail}</span>
                ) : null}
              </span>
              {variant !== "segmented" ? (
                <CheckIcon className="icon choice-check" size={20} />
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

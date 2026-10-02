"use client";

import { useId, useState } from "react";
import { ClockIcon, PencilIcon } from "./Icons";

type TimeCardProps = {
  /** Accessible label of the underlying native input. */
  label: string;
  /** Large summary line, e.g. "Today, 7:48 am". */
  summary: string;
  /** Optional hint under the summary. */
  hint?: string;
  editLabel: string;
  type: "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  error?: string;
};

/**
 * v1 time summary card. The native time input is always in the form (so
 * it is submitted and testable) and is revealed by "Edit time"; it opens
 * automatically when its value is invalid.
 */
export function TimeCard({ label, summary, hint, editLabel, type, value, onChange, error }: TimeCardProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const open = editing || Boolean(error);
  return (
    <div className={`time-card ${error ? "time-card--invalid" : ""}`.trim()}>
      <div className="time-card-summary">
        <ClockIcon size={30} className="icon time-card-icon" />
        <div className="time-card-text">
          <p className="time-card-value">{summary}</p>
          {hint ? <p className="time-card-hint">{hint}</p> : null}
        </div>
        <button
          type="button"
          className="text-link"
          aria-expanded={open}
          aria-controls={`${id}-editor`}
          onClick={() => setEditing((current) => !current)}
        >
          <PencilIcon size={18} />
          {editLabel}
        </button>
      </div>
      <div className="time-card-editor field" id={`${id}-editor`} hidden={!open}>
        <label className="field-label" htmlFor={`${id}-input`}>
          {label}
        </label>
        <input
          id={`${id}-input`}
          className="input"
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error ? (
          <p className="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import {
  type ReactNode,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
  forwardRef,
  useId,
} from "react";

type FieldChromeProps = {
  /** Visible label; may include `sr-only` spans that complete the name. */
  label: ReactNode;
  error?: string;
  hint?: string;
  /** Decorative leading icon inside the control. */
  icon?: ReactNode;
  /** Decorative trailing text (for example a unit already in the label). */
  suffix?: ReactNode;
  /** Extra class on the field wrapper for screen-specific sizing. */
  fieldClassName?: string;
};

function describedBy(fieldId: string, error?: string, hint?: string) {
  return (
    [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function FieldFooter({ fieldId, error, hint }: { fieldId: string; error?: string; hint?: string }) {
  return (
    <>
      {hint ? (
        <p className="field-hint" id={`${fieldId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${fieldId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

// Required state is conveyed by the native `required` attribute and inline
// validation messages; v1 frames show no decorative asterisk.
function FieldLabel({ fieldId, label }: { fieldId: string; label: ReactNode }) {
  return (
    <label className="field-label" htmlFor={fieldId}>
      {label}
    </label>
  );
}

type InputFieldProps = InputHTMLAttributes<HTMLInputElement> & FieldChromeProps;

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(
  function InputField(
    { label, error, hint, icon, suffix, fieldClassName = "", required, id, className = "", ...rest },
    ref,
  ) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const control = (
      <input
        ref={ref}
        id={fieldId}
        className={`input ${icon ? "input--with-icon" : ""} ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, error, hint)}
        required={required}
        {...rest}
      />
    );
    return (
      <div className={`field ${fieldClassName}`.trim()}>
        <FieldLabel fieldId={fieldId} label={label} />
        {icon || suffix ? (
          <div className="input-wrap">
            {icon ? <span className="input-icon">{icon}</span> : null}
            {control}
            {suffix ? (
              <span className="input-suffix" aria-hidden="true">
                {suffix}
              </span>
            ) : null}
          </div>
        ) : (
          control
        )}
        <FieldFooter fieldId={fieldId} error={error} hint={hint} />
      </div>
    );
  },
);

type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Omit<FieldChromeProps, "icon" | "suffix">;

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField({ label, error, hint, fieldClassName = "", required, id, ...rest }, ref) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    return (
      <div className={`field ${fieldClassName}`.trim()}>
        <FieldLabel fieldId={fieldId} label={label} />
        <textarea
          ref={ref}
          id={fieldId}
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          required={required}
          {...rest}
        />
        <FieldFooter fieldId={fieldId} error={error} hint={hint} />
      </div>
    );
  },
);

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> &
  Omit<FieldChromeProps, "icon" | "suffix"> & { children: ReactNode };

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    { label, error, hint, fieldClassName = "", required, id, children, ...rest },
    ref,
  ) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    return (
      <div className={`field ${fieldClassName}`.trim()}>
        <FieldLabel fieldId={fieldId} label={label} />
        <select
          ref={ref}
          id={fieldId}
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          required={required}
          {...rest}
        >
          {children}
        </select>
        <FieldFooter fieldId={fieldId} error={error} hint={hint} />
      </div>
    );
  },
);

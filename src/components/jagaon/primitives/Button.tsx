"use client";

import { type ReactNode, type ComponentPropsWithRef } from "react";

// React 19 passes `ref` as a prop, so callers can focus the button.
type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "outline" | "ghost";
  busy?: boolean;
  children: ReactNode;
};

export function Button({
  variant = "primary",
  busy = false,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const variantClass = `btn btn-${variant}`;

  return (
    <button
      type="button"
      className={`${variantClass} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

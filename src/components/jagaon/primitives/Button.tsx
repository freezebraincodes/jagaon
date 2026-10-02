"use client";

import { type ReactNode, type ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
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

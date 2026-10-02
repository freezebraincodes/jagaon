"use client";

import { type ReactNode } from "react";
import { CheckIcon, InfoIcon } from "./Icons";

type CardProps = {
  children: ReactNode;
  tinted?: boolean;
  className?: string;
};

export function Card({ children, tinted = false, className = "" }: CardProps) {
  const cls = tinted ? "card card-tinted" : "card";
  return <div className={`${cls} ${className}`.trim()}>{children}</div>;
}

type BannerProps = {
  variant?: "info" | "warning" | "error" | "success";
  title?: string;
  children: ReactNode;
};

/** Live status message for state changes (saved, not saved, provider states). */
export function Banner({ variant = "info", title, children }: BannerProps) {
  return (
    <div className={`banner banner-${variant}`} role="status">
      <span className="banner-icon">
        {variant === "success" ? <CheckIcon size={22} /> : <InfoIcon size={22} />}
      </span>
      <div className="banner-content">
        {title ? <p className="banner-title">{title}</p> : null}
        {typeof children === "string" ? (
          <p className="banner-body">{children}</p>
        ) : (
          <div className="banner-body">{children}</div>
        )}
      </div>
    </div>
  );
}

type ToggleGroupProps = {
  options: Array<{ label: string; value: string; icon?: ReactNode }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
};

export function ToggleGroup({ options, value, onChange, label }: ToggleGroupProps) {
  return (
    <div className="toggle-group" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="toggle-button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

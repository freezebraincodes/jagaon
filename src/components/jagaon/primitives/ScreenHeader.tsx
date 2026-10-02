import type { ReactNode } from "react";
import { InfoIcon } from "./Icons";

/** Child-screen title row; the shell places the back button beside it. */
export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="screen-header">
      <h1 className="screen-title">{title}</h1>
      {subtitle ? <p className="screen-subtitle">{subtitle}</p> : null}
    </header>
  );
}

/** Static product-boundary or provenance note (not a live status). */
export function Notice({
  children,
  icon,
  className = "",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`notice ${className}`.trim()}>
      <span className="notice-icon">{icon ?? <InfoIcon size={20} />}</span>
      <div className="notice-body">{children}</div>
    </div>
  );
}

/** Small uppercase section label used across v1 frames. */
export function Eyebrow({
  children,
  icon,
  as: Tag = "p",
  id,
}: {
  children: ReactNode;
  icon?: ReactNode;
  as?: "p" | "h2" | "h3";
  id?: string;
}) {
  return (
    <Tag className="eyebrow" id={id}>
      {icon}
      {children}
    </Tag>
  );
}

import type { ReactNode } from "react";

/**
 * A contact card link (Help screen, frame 13): icon, approved action text (it already contains the number), an optional detail line,
 * and the number shown large (hidden from assistive technology because the action text already says it). Shared by the Help screen
 * and the Tell JagaOn distress message (owner decision 2026-10-14).
 */
export function ContactLink({
  href,
  icon,
  action,
  detail,
  number,
  emphasis = false,
  stacked = false,
  external = false,
}: {
  href: string;
  icon: ReactNode;
  /** Approved action text; it already contains the number. */
  action: string;
  /** Category, provider or hours shown under the action. */
  detail?: string;
  number: string;
  emphasis?: boolean;
  /** Long action text: show the number on its own line. */
  stacked?: boolean;
  /** A web link (WhatsApp chat): opens in a new tab so the current screen stays. */
  external?: boolean;
}) {
  const variants = [emphasis ? "contact-card--emphasis" : "", stacked ? "contact-card--stacked" : ""];
  return (
    <a href={href} className={["contact-card", ...variants].filter(Boolean).join(" ")} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
      <span className="contact-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="contact-text">
        <span className="contact-action">{action}</span>
        {detail ? <span className="contact-detail">{detail}</span> : null}
      </span>
      {/* The number is already part of the approved action text. */}
      <span className="contact-number" aria-hidden="true">
        {number}
      </span>
    </a>
  );
}

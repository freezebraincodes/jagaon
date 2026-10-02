"use client";

import { useMemo, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";
import { createHelpInformationAdapter } from "@/application/governed/help-information-adapter";
import {
  AmbulanceIcon,
  BookIcon,
  ExternalIcon,
  MessageIcon,
  PhoneIcon,
} from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";

type HelpScreenProps = {
  messages: AppMessages;
  goBack: () => void;
};

function ContactLink({
  href,
  icon,
  action,
  detail,
  number,
  emphasis = false,
  stacked = false,
}: {
  href: string;
  icon: ReactNode;
  /** Approved action text; it already contains the number. */
  action: string;
  /** Category or provider shown under the action. */
  detail: string;
  number: string;
  emphasis?: boolean;
  /** Long action text: show the number on its own line. */
  stacked?: boolean;
}) {
  const variants = [emphasis ? "contact-card--emphasis" : "", stacked ? "contact-card--stacked" : ""];
  return (
    <a href={href} className={["contact-card", ...variants].filter(Boolean).join(" ")}>
      <span className="contact-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="contact-text">
        <span className="contact-action">{action}</span>
        <span className="contact-detail">{detail}</span>
      </span>
      {/* The number is already part of the approved action text. */}
      <span className="contact-number" aria-hidden="true">
        {number}
      </span>
    </a>
  );
}

export function HelpScreen({ messages }: HelpScreenProps) {
  const msg = messages.help;
  const adapter = useMemo(() => createHelpInformationAdapter(), []);
  const info = adapter.getHelpInformation();

  return (
    <div className="screen-page help-screen">
      <ScreenHeader title={msg.title} />

      <Notice icon={<BookIcon size={20} />}>{msg.noAssessment}</Notice>

      <section className="help-section" aria-labelledby="help-contacts-heading">
        <h2 id="help-contacts-heading" className="eyebrow">
          {msg.generalContacts}
        </h2>
        <ContactLink
          href={`tel:${info.emergencyNumber}`}
          icon={<AmbulanceIcon size={28} />}
          action={msg.call995}
          detail={`${msg.emergencyHeading} · ${info.emergencyProvider}`}
          number={info.emergencyNumber}
          emphasis
        />
        <ContactLink
          href={`sms:${info.emergencySmsNumber}`}
          icon={<MessageIcon size={28} />}
          action={msg.accessibleEmergency}
          detail={info.emergencyProvider}
          number={info.emergencySmsNumber}
          stacked
        />
        <ContactLink
          href={`tel:${info.nurseAdviceNumber.replace(/\s/g, "")}`}
          icon={<PhoneIcon size={28} />}
          action={msg.nurseFirst}
          detail={msg.nonEmergencyHeading}
          number={info.nurseAdviceNumber}
        />
      </section>

      <section className="help-section" aria-labelledby="help-general-heading">
        <h2 id="help-general-heading" className="eyebrow">
          {messages.medication.generalHeading}
        </h2>
        <div className="info-card">
          <BookIcon size={28} className="icon info-card-icon" />
          <p className="info-card-text">{msg.publicInfoUnavailable}</p>
        </div>
      </section>

      <p className="source-attr help-source">
        <a href={info.verifyWebsite} target="_blank" rel="noreferrer noopener">
          {msg.verifyCurrent}
          <ExternalIcon size={14} />
        </a>
        <span>
          {" "}
          · {messages.shared.reviewedOn(info.checkedOn)}
        </span>
      </p>
    </div>
  );
}

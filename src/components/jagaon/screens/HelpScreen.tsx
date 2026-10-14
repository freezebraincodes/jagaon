"use client";

import { useMemo } from "react";
import type { AppMessages } from "@/i18n/types";
import { createHelpInformationAdapter, telHref, whatsAppHref } from "@/application/governed/help-information-adapter";
import {
  AmbulanceIcon,
  BookIcon,
  ExternalIcon,
  MessageIcon,
  PhoneIcon,
} from "../primitives/Icons";
import { ContactLink } from "../primitives/ContactLink";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";

type HelpScreenProps = {
  messages: AppMessages;
  goBack: () => void;
};

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
          href={telHref(info.nurseAdviceNumber)}
          icon={<PhoneIcon size={28} />}
          action={msg.nurseFirst}
          detail={msg.nonEmergencyHeading}
          number={info.nurseAdviceNumber}
        />
      </section>

      {/* Owner decision 2026-10-14 (distress safety): emotional support lines, after the general contacts. */}
      <section className="help-section" aria-labelledby="help-emotional-heading">
        <h2 id="help-emotional-heading" className="eyebrow">
          {msg.emotionalSupportHeading}
        </h2>
        <ContactLink href={telHref(info.sosNumber)} icon={<PhoneIcon size={28} />} action={msg.sosCall} detail={`${msg.sosProvider} · ${msg.sosHours}`} number={info.sosNumber} />
        <ContactLink href={whatsAppHref(info.sosWhatsAppNumber)} icon={<MessageIcon size={28} />} action={msg.sosWhatsApp} detail={`${msg.sosProvider} · ${msg.sosHours}`} number={info.sosWhatsAppNumber} stacked external />
        <ContactLink href={telHref(info.mindlineNumber)} icon={<PhoneIcon size={28} />} action={msg.mindlineCall} detail={`${msg.mindlineProvider} · ${msg.mindlineHours}`} number={info.mindlineNumber} />
        <ContactLink href={whatsAppHref(info.mindlineWhatsAppNumber)} icon={<MessageIcon size={28} />} action={msg.mindlineWhatsApp} detail={`${msg.mindlineProvider} · ${msg.mindlineHours}`} number={info.mindlineWhatsAppNumber} stacked external />
        <p className="source-attr help-source">
          <span>{msg.emotionalSupportVerify}</span>
          <a href={info.sosWebsite} target="_blank" rel="noreferrer noopener">
            {msg.sosWebsite}
            <ExternalIcon size={14} />
          </a>
          <span aria-hidden="true">·</span>
          <a href={info.mindlineWebsite} target="_blank" rel="noreferrer noopener">
            {msg.mindlineWebsite}
            <ExternalIcon size={14} />
          </a>
          <span> · {messages.shared.reviewedOn(info.emotionalSupportCheckedOn)}</span>
        </p>
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

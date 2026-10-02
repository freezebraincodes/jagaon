"use client";

import { useMemo } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { DemoPatientProfile } from "@/application/governed/demo-scenario-fixture";
import { createMedicationInformationAdapter } from "@/application/governed/medication-information-adapter";
import { labelAndValue } from "../locale-format";
import {
  BookIcon,
  ChevronRightIcon,
  DocumentIcon,
  ExternalIcon,
  HistoryIcon,
  PenIcon,
  PencilIcon,
  QuestionIcon,
} from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";

type MedicationInformationScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  fixture: DemoPatientProfile;
  goBack: () => void;
};

function formatRecordedDate(locale: SupportedLocale, date: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function MedicationInformationScreen({
  messages,
  locale,
  fixture,
}: MedicationInformationScreenProps) {
  const msg = messages.medication;
  const adapter = useMemo(() => createMedicationInformationAdapter(), []);

  return (
    <div className="screen-page medication-screen">
      <ScreenHeader title={msg.screenTitle} />

      <div className="medication-list">
        {fixture.recordedPrescriptions.map((rx) => {
          const info = adapter.getGeneralInfo(rx.medicationId, messages, locale);
          const reviewed = rx.hasReviewedInfo && info.available;
          const ids = {
            name: `${rx.medicationId}-name`,
            reviewed: `${rx.medicationId}-reviewed`,
            recorded: `${rx.medicationId}-recorded`,
            actions: `${rx.medicationId}-actions`,
          };
          const provenanceLabel =
            rx.provenance.kind === "ENTERED_BY_USER" ? msg.provenanceUser : msg.provenanceDocument;

          return (
            <article key={rx.medicationId} className="medication-card" aria-labelledby={ids.name}>
              <header className="medication-header">
                <span className="medication-mark" aria-hidden="true">
                  <PenIcon size={26} />
                </span>
                <div className="medication-heading">
                  <h2 id={ids.name} className="medication-name">
                    {rx.displayName}
                  </h2>
                  <p className="medication-generic">{rx.genericName}</p>
                </div>
              </header>

              {/* 1. Reviewed general information — never personalised. */}
              <section className="medication-region medication-reviewed" aria-labelledby={ids.reviewed}>
                <h3 id={ids.reviewed} className="tag tag--reviewed">
                  <BookIcon size={16} />
                  {msg.reviewedTag}
                </h3>
                {reviewed ? (
                  <details className="reviewed-details">
                    <summary>
                      <span className="reviewed-summary-title">{msg.aboutThisMedicine}</span>
                      <span className="reviewed-summary-note">{msg.notPersonalised}</span>
                    </summary>
                    <div className="reviewed-body">
                      <p className="medication-text">{info.purpose}</p>
                      <p className="medication-text">{info.use}</p>
                      <p className="source-attr">
                        <a href={info.sourceUrl} target="_blank" rel="noreferrer noopener">
                          {labelAndValue(locale, messages.shared.source, info.sourceName)}
                          <ExternalIcon size={14} />
                        </a>
                        {" · "}
                        {info.reviewedOnLabel}
                      </p>
                    </div>
                  </details>
                ) : (
                  <p className="medication-text">{msg.infoUnavailable}</p>
                )}
              </section>

              {/* 2. Recorded data — shown exactly as entered or transcribed. */}
              <section className="medication-region medication-recorded" aria-labelledby={ids.recorded}>
                <p className="tag tag--recorded">
                  <DocumentIcon size={16} />
                  {msg.recordedTag}
                </p>
                <h3 id={ids.recorded} className="medication-region-title">
                  {msg.recordedHeading}
                </h3>
                <dl className="recorded-facts">
                  <div>
                    <dt>{messages.insulin.medicineLabel}</dt>
                    <dd>{`${rx.displayName} (${rx.genericName})`}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldForm}</dt>
                    <dd>{rx.form}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldAmount}</dt>
                    <dd>{rx.amountText}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldTiming}</dt>
                    <dd>{rx.timingText}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldEffective}</dt>
                    <dd>{formatRecordedDate(locale, rx.effectiveDate)}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldProvenance}</dt>
                    <dd>{rx.provenance.detail}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldDirections}</dt>
                    <dd>
                      <blockquote className="recorded-direction-text">{rx.recordedDirection}</blockquote>
                    </dd>
                  </div>
                </dl>
                <p className="provenance-chip">
                  {rx.provenance.kind === "ENTERED_BY_USER" ? <PencilIcon size={16} /> : <DocumentIcon size={16} />}
                  {provenanceLabel}
                </p>
                <p className="provenance-line">{msg.recordedVerbatim}</p>
              </section>

              {/* 3. The person's own actions — questions to bring, not advice. */}
              <section className="medication-region medication-questions" aria-labelledby={ids.actions}>
                <h3 id={ids.actions} className="tag tag--action">
                  <QuestionIcon size={16} />
                  {msg.actionsTag}
                </h3>
                <p className="eyebrow eyebrow--small">{msg.askHeading}</p>
                <ul className="question-list">
                  {[msg.askPurpose, msg.askDirections].map((question) => (
                    <li key={question}>
                      <span className="question-label">{msg.sampleQuestionLabel}</span>
                      <span className="question-text">{question}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="action-row"
                  disabled
                  aria-disabled="true"
                  aria-describedby={`${ids.actions}-later`}
                >
                  <QuestionIcon size={24} />
                  <span>{msg.addQuestion}</span>
                  <ChevronRightIcon size={20} />
                </button>
                <p className="provenance-line" id={`${ids.actions}-later`}>
                  {messages.today.futureFeature}
                </p>
                <details className="source-history">
                  <summary>
                    <HistoryIcon size={22} />
                    {msg.sourceHistory}
                  </summary>
                  <dl className="recorded-facts">
                    {reviewed ? (
                      <div>
                        <dt>{msg.reviewedTag}</dt>
                        <dd>{`${info.sourceName} · ${info.reviewedOnLabel}`}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{msg.recordedTag}</dt>
                      <dd>{`${provenanceLabel} · ${rx.provenance.detail}`}</dd>
                    </div>
                  </dl>
                </details>
              </section>
            </article>
          );
        })}
      </div>

      <Notice>{msg.generalLimit}</Notice>
    </div>
  );
}

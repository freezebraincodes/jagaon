"use client";

import { useMemo, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { DemoPatientProfile } from "@/application/governed/demo-scenario-fixture";
import { createMedicationInformationAdapter } from "@/application/governed/medication-information-adapter";
import { labelAndValue } from "../locale-format";
import { sourceLabel } from "../onboarding/medicine-labels";
import { CareQuestionEditor } from "../care-organisation/CareQuestionEditor";
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
  /**
   * Owner decision 2026-10-14: "Add a question for my doctor or pharmacist" saves her own question to Prepare for my appointment
   * (unticked), as "Add my own question" does there. Without it the action stays the disabled placeholder.
   */
  addCareQuestion?: (text: string) => Promise<boolean>;
};

export function MedicationInformationScreen({
  messages,
  locale,
  fixture,
  addCareQuestion,
}: MedicationInformationScreenProps) {
  const msg = messages.medication;
  const adapter = useMemo(() => createMedicationInformationAdapter(), []);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [addedFor, setAddedFor] = useState<string | null>(null);

  async function saveQuestion(text: string) {
    if (!addCareQuestion || asking === null) return;
    setBusy(true);
    setFailed(false);
    const saved = await addCareQuestion(text).catch(() => false);
    setBusy(false);
    if (!saved) {
      setFailed(true);
      return;
    }
    setAddedFor(asking);
    setAsking(null);
  }

  return (
    <div className="screen-page medication-screen">
      <ScreenHeader title={msg.screenTitle} />

      <div className="medication-list">
        {fixture.recordedPrescriptions.map((rx) => {
          const info = adapter.getGeneralInfo(rx.medicationId, messages, locale);
          const reviewed = rx.hasReviewedInfo && info.available;
          const ids = {
            name: `${rx.medicationRecordId}-name`,
            reviewed: `${rx.medicationRecordId}-reviewed`,
            recorded: `${rx.medicationRecordId}-recorded`,
            actions: `${rx.medicationRecordId}-actions`,
          };
          const provenanceLabel = sourceLabel(messages, rx.source);
          const unknown = messages.onboarding.unknownValue;

          return (
            <article key={rx.medicationRecordId} className="medication-card" aria-labelledby={ids.name}>
              <header className="medication-header">
                <span className="medication-mark" aria-hidden="true">
                  <PenIcon size={26} />
                </span>
                <div className="medication-heading">
                  <h2 id={ids.name} className="medication-name">
                    {rx.displayName}
                  </h2>
                  {rx.genericName ? <p className="medication-generic">{rx.genericName}</p> : null}
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
                    <dd>{rx.genericName ? `${rx.displayName} (${rx.genericName})` : rx.displayName}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldForm}</dt>
                    <dd>{rx.form ?? unknown}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldAmount}</dt>
                    <dd>{rx.amountText ?? unknown}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldTiming}</dt>
                    <dd>{rx.timingText ?? unknown}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldEffective}</dt>
                    <dd>{rx.effectiveDate ?? unknown}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldProvenance}</dt>
                    <dd>{provenanceLabel}</dd>
                  </div>
                  <div>
                    <dt>{msg.fieldDirections}</dt>
                    <dd>
                      <blockquote className="recorded-direction-text">{rx.recordedDirection ?? unknown}</blockquote>
                    </dd>
                  </div>
                </dl>
                <p className="provenance-chip">
                  {rx.source === "PATIENT_ENTERED" ? <PencilIcon size={16} /> : <DocumentIcon size={16} />}
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
                {addCareQuestion ? (
                  <>
                    <button
                      type="button"
                      className="action-row"
                      onClick={() => {
                        setFailed(false);
                        setAsking(rx.medicationRecordId);
                      }}
                    >
                      <QuestionIcon size={24} />
                      <span>{msg.addQuestion}</span>
                      <ChevronRightIcon size={20} />
                    </button>
                    {addedFor === rx.medicationRecordId ? (
                      <p className="provenance-line" role="status">
                        {msg.questionAdded}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
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
                  </>
                )}
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
                      <dd>{provenanceLabel}</dd>
                    </div>
                  </dl>
                </details>
              </section>
            </article>
          );
        })}
      </div>

      <Notice>{msg.generalLimit}</Notice>
      {asking !== null && addCareQuestion ? (
        <CareQuestionEditor messages={messages} initialText={null} busy={busy} failed={failed} onSave={(text) => void saveQuestion(text)} onClose={() => setAsking(null)} />
      ) : null}
    </div>
  );
}

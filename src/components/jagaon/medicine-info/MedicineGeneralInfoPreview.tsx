"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createMedicineInfoClient, type MedicineInfoClient, type MedicineInfoResult } from "@/application/medicine-info/medicine-info-client";
import { isMedicineInfoCreditLimit } from "@/application/medicine-info/medicine-info-route-contract";
import { toMedicineInfoName } from "@/domain/medicine-info/medicine-info-contract";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { AiCreditLimitDialog } from "../ai/AiCreditLimitDialog";
import { PreviewTag, useHsaBoundedMode } from "../hsa/hsa-bounded-mode";
import { ExternalIcon, InfoIcon } from "../primitives/Icons";
import { ModalDialog } from "../primitives/ModalDialog";

/**
 * HSA preview (owner decision 2026-10-14): "Get general information with AI" for a medicine without reviewed HealthHub information.
 *
 * While HSA-bounded mode is ON (the default) this renders NOTHING, so every screen keeps today's behaviour. While it is OFF:
 * - a button "Get general information with AI" (only for a name that passes the request's name rule);
 * - the first time for each medicine on this device, a notice says what is sent (only the name) and that the result is general
 *   information, not advice: Continue or Cancel;
 * - "Looking up general information…", then the card: the PREVIEW and "AI-generated general information" tags, "About this medicine",
 *   what it is generally used for, how it is generally taken, the date it was generated, a "Search HealthHub" link (new tab) so she
 *   can check herself, the caution line and Refresh;
 * - NOT_FOUND or a rejected answer: "JagaOn couldn't find reliable general information for this name…"; unavailable: a short line and
 *   the button again; the demo's AI credit used up: the shared AI credit-limit dialog, then the unavailable line.
 * A cached answer is shown at once (validated again by the client). Nothing here changes her recorded directions or saves a record.
 * The AI never doses, instructs, diagnoses or advises: the route and the client both run medicine-info-validator.1.
 */
export const HEALTHHUB_MEDICATIONS_URL = "https://www.healthhub.sg/medication-devices-and-treatment/medications";

const MedicineInfoClientContext = createContext<MedicineInfoClient | null>(null);

/** Supplies the medicine-information client (tests: a fake fetcher; the app: the default same-origin client). */
export function MedicineInfoClientProvider({ client, children }: { client: MedicineInfoClient; children: ReactNode }) {
  return <MedicineInfoClientContext.Provider value={client}>{children}</MedicineInfoClientContext.Provider>;
}

let defaultClient: MedicineInfoClient | null = null;
function useMedicineInfoClient(): MedicineInfoClient {
  const provided = useContext(MedicineInfoClientContext);
  return provided ?? (defaultClient ??= createMedicineInfoClient());
}

type Shown = Extract<MedicineInfoResult, { kind: "OK" }>;
type View =
  | Readonly<{ kind: "IDLE" }>
  | Readonly<{ kind: "NOTICE" }>
  | Readonly<{ kind: "LOADING" }>
  | Readonly<{ kind: "SHOWN"; result: Shown }>
  | Readonly<{ kind: "NO_INFO" }>
  | Readonly<{ kind: "UNAVAILABLE" }>;

type Props = Readonly<{
  messages: AppMessages;
  locale: SupportedLocale;
  /** The medicine name as she sees it in her records (or as she said it). Only this is ever sent. */
  name: string;
  /** The card title's heading level inside the host section. */
  headingLevel?: 3 | 4;
}>;

function formatGeneratedOn(fetchedAt: string, locale: SupportedLocale): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" }).format(new Date(fetchedAt));
  } catch {
    return fetchedAt.slice(0, 10);
  }
}

export function MedicineGeneralInfoPreview(props: Props) {
  const { bounded } = useHsaBoundedMode();
  const requestName = toMedicineInfoName(props.name);
  // Bounded mode (the default) adds nothing; neither does a name the request could not carry.
  if (bounded || requestName === null) return null;
  return <PreviewLookup key={requestName.toLowerCase()} {...props} name={requestName} />;
}

function PreviewLookup({ messages, locale, name, headingLevel = 4 }: Props) {
  const t = messages.hsaMedicineInfo;
  const client = useMedicineInfoClient();
  const id = useId();
  const [view, setView] = useState<View>(() => {
    const cached = client.cached(name);
    return cached ? { kind: "SHOWN", result: cached } : { kind: "IDLE" };
  });
  const [creditLimit, setCreditLimit] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function lookUp(refresh: boolean) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setView({ kind: "LOADING" });
    const result = await client.get(name, { refresh, signal: controller.signal });
    if (controller.signal.aborted) return;
    pending.current = null;
    if (result.kind === "OK") return setView({ kind: "SHOWN", result });
    if (result.kind === "NO_RELIABLE_INFO") return setView({ kind: "NO_INFO" });
    if (isMedicineInfoCreditLimit(result.reason)) setCreditLimit(true);
    setView({ kind: "UNAVAILABLE" });
  }

  function start() {
    if (client.noticeAccepted(name)) void lookUp(false);
    else setView({ kind: "NOTICE" });
  }

  const Heading = headingLevel === 3 ? "h3" : "h4";
  const titleId = `${id}-title`;
  const getButton = (
    <button type="button" className="btn btn-outline btn-wide medicine-ai-get" onClick={start}>
      {t.getButton}
    </button>
  );

  return (
    <div className="medicine-ai">
      {view.kind === "IDLE" || view.kind === "NOTICE" ? getButton : null}
      {view.kind === "LOADING" ? (
        <p role="status" className="medicine-ai-status">
          {t.loading}
        </p>
      ) : null}
      {view.kind === "NO_INFO" ? (
        <p role="status" className="medicine-ai-status">
          {t.noReliableInfo}
        </p>
      ) : null}
      {view.kind === "UNAVAILABLE" ? (
        <>
          <p role="status" className="medicine-ai-status">
            {t.unavailable}
          </p>
          {getButton}
        </>
      ) : null}
      {view.kind === "SHOWN" ? (
        <article className="medicine-ai-card" aria-labelledby={titleId}>
          <p className="medicine-ai-eyebrow">
            <PreviewTag messages={messages} />
            <span className="tag medicine-ai-tag">{t.cardTag}</span>
          </p>
          <Heading id={titleId} className="medicine-ai-title">
            {t.cardTitle(view.result.info.name)}
          </Heading>
          {view.result.info.genericName ? <p className="medicine-ai-generic">{view.result.info.genericName}</p> : null}
          <dl className="medicine-ai-facts">
            <div>
              <dt>{t.usedForLabel}</dt>
              <dd>{view.result.info.usedFor}</dd>
            </div>
            <div>
              <dt>{t.howTakenLabel}</dt>
              <dd>{view.result.info.howGenerallyTaken}</dd>
            </div>
          </dl>
          <p className="source-attr medicine-ai-source">
            {t.generatedOn(formatGeneratedOn(view.result.fetchedAt, locale))}
            {" · "}
            <a href={HEALTHHUB_MEDICATIONS_URL} target="_blank" rel="noopener noreferrer">
              {t.searchHealthHub}
              <ExternalIcon size={14} />
              <span className="sr-only">{` ${t.opensInNewTab}`}</span>
            </a>
          </p>
          {view.result.refreshFailed ? (
            <p role="status" className="medicine-ai-status">
              {t.refreshFailed}
            </p>
          ) : null}
          <p className="notice notice--compact medicine-ai-caution">
            <InfoIcon size={18} />
            <span>{t.caution}</span>
          </p>
          <button type="button" className="btn btn-outline medicine-ai-refresh" onClick={() => void lookUp(true)}>
            {t.refresh}
          </button>
        </article>
      ) : null}
      {view.kind === "NOTICE" ? (
        <ModalDialog
          className="medicine-ai-notice-dialog"
          title={t.noticeTitle}
          description={<p>{t.noticeBody(name)}</p>}
          onClose={() => setView({ kind: "IDLE" })}
          initialFocusSelector="[data-medicine-ai-safe]"
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary btn-wide"
                onClick={() => {
                  client.acceptNotice(name);
                  void lookUp(false);
                }}
              >
                {t.noticeContinue}
              </button>
              <button type="button" className="btn btn-outline btn-wide" data-medicine-ai-safe="" onClick={() => setView({ kind: "IDLE" })}>
                {t.noticeCancel}
              </button>
            </>
          }
        >
          {null}
        </ModalDialog>
      ) : null}
      {creditLimit ? <AiCreditLimitDialog messages={messages} flow="MEDICINE_INFO" onClose={() => setCreditLimit(false)} /> : null}
    </div>
  );
}

